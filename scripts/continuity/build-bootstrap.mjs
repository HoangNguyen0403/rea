import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { builtinModules } from "node:module";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { rolldown } from "rolldown";

import { reportFailure, requireValue, UsageError } from "./lib/cli.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const USAGE =
  "Usage: node scripts/continuity/build-bootstrap.mjs --output DIR [--json]";
const ENTRYPOINTS = {
  "verify-retained-bundle": "scripts/continuity/verify-retained-bundle.mjs",
  "restore-retained-bundle": "scripts/continuity/restore-retained-bundle.mjs",
  "rollback-retained-install":
    "scripts/continuity/rollback-retained-install.mjs",
  "smoke-static-js": "scripts/continuity/smoke-static-js.mjs",
};
const EXTERNAL = new Set([
  "node:fs/promises",
  "node:fs",
  "node:child_process",
  "node:crypto",
  "node:path",
  "node:url",
  "node:util",
  "node:module",
  "node:os",
]);

try {
  const { values } = parseArgs({
    options: {
      output: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) process.stdout.write(`${USAGE}\n`);
  else {
    const output = resolve(requireValue(values.output, "--output"));
    const result = await buildBootstrap(output);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
} catch (cause) {
  reportFailure(cause, USAGE);
}

async function buildBootstrap(output) {
  const semverPackage = JSON.parse(
    await readFile(join(ROOT, "node_modules/semver/package.json"), "utf8"),
  );
  if (typeof semverPackage.version !== "string")
    throw new Error("Pinned semver package metadata is unavailable");
  await mkdir(dirname(output), { recursive: true });
  const temporary = await mkdtemp(
    join(dirname(output), `.${basename(output)}-boot-`),
  );
  try {
    const bundle = await rolldown({
      input: Object.fromEntries(
        Object.entries(ENTRYPOINTS).map(([name, path]) => [
          name,
          join(ROOT, path),
        ]),
      ),
      platform: "node",
      treeshake: false,
      external: (source) =>
        EXTERNAL.has(source) ||
        source.startsWith("node:") ||
        (builtinModules.includes(source) && !source.startsWith(".")),
    });
    try {
      await bundle.write({
        dir: temporary,
        format: "esm",
        entryFileNames: "[name].mjs",
        chunkFileNames: "chunks/[name]-[hash].mjs",
      });
    } finally {
      await bundle.close();
    }
    for (const name of Object.keys(ENTRYPOINTS)) {
      const info = await lstat(join(temporary, `${name}.mjs`)).catch(
        () => null,
      );
      if (info === null || !info.isFile())
        throw new Error(`Bootstrap entrypoint ${name}.mjs was not generated`);
    }
    for (const file of await walk(temporary, ["bootstrap-manifest.json"])) {
      if (!file.path.endsWith(".mjs")) continue;
      const source = await readFile(join(temporary, file.path), "utf8");
      for (const match of source.matchAll(
        /(?:from\s*|import\s*\(\s*)["']([^"']+)["']/gu,
      )) {
        const specifier = match[1];
        if (
          specifier.startsWith(".") ||
          specifier.startsWith("node:") ||
          builtinModules.includes(specifier)
        )
          continue;
        throw new Error(
          `Bootstrap retained an unresolved package import: ${specifier}`,
        );
      }
    }
    await cp(join(ROOT, "LICENSE"), join(temporary, "LICENSE"));
    await cp(
      join(ROOT, "THIRD_PARTY_NOTICES.md"),
      join(temporary, "THIRD_PARTY_NOTICES.md"),
    );
    const semverLicense = (
      await readdir(join(ROOT, "node_modules/semver"))
    ).find((name) => /^licen[cs]e/iu.test(name));
    if (semverLicense === undefined)
      throw new Error("Pinned semver license notice is unavailable");
    await cp(
      join(ROOT, "node_modules/semver", semverLicense),
      join(temporary, "semver-LICENSE.txt"),
    );
    const files = await walk(temporary, ["bootstrap-manifest.json"]);
    const manifest = {
      schemaVersion: 1,
      kind: "rea-continuity-bootstrap",
      createdAt: new Date().toISOString(),
      semver: {
        version: semverPackage.version,
        license: "ISC",
        notice: "semver-LICENSE.txt",
      },
      entrypoints: Object.keys(ENTRYPOINTS).sort(),
      files,
    };
    const manifestPath = join(temporary, "bootstrap-manifest.json");
    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    const result = {
      output,
      entrypoints: manifest.entrypoints.map((name) => `${name}.mjs`),
      bootstrapManifestSha256: await hashFile(manifestPath),
      semver: manifest.semver.version,
      files: files.length,
    };
    await lstat(output).then(
      () => {
        throw new UsageError(`Output already exists: ${output}`);
      },
      (cause) => {
        if (cause?.code !== "ENOENT") throw cause;
      },
    );
    await rename(temporary, output);
    return result;
  } catch (cause) {
    await rm(temporary, { recursive: true, force: true });
    throw cause;
  }
}

async function walk(root, exclude = []) {
  const excluded = new Set(exclude);
  const files = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(
          `Bootstrap output contains a symbolic link: ${absolute}`,
        );
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile())
        throw new Error(
          `Bootstrap output contains a non-regular entry: ${absolute}`,
        );
      const path = relative(root, absolute).split(sep).join("/");
      if (!excluded.has(path))
        files.push({
          path,
          bytes: (await lstat(absolute)).size,
          sha256: await hashFile(absolute),
        });
    }
  };
  await visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function hashFile(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
