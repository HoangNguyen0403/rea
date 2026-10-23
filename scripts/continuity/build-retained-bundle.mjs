import { execFile } from "node:child_process";
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
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

import { satisfies, valid } from "semver";

import { reportFailure, requireValue, UsageError } from "./lib/cli.mjs";
import { inspectTarArchive } from "./lib/tar-safety.mjs";
import {
  MANIFEST_NAME,
  sha256File,
  writeBundleInventory,
} from "./lib/bundle-fs.mjs";
import {
  BUNDLE_KIND,
  BUNDLE_SCHEMA_VERSION,
  assertBundleManifest,
} from "./lib/bundle-manifest.mjs";
import { git, gitMaybe, resolveCommit, sanitizeOutput } from "./lib/git.mjs";
import { retainLicenses } from "./lib/license-retention.mjs";

const execute = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MAX_BUFFER = 64 * 1024 * 1024;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const REQUIRED_PACKAGE_FILES = [
  "package/dist/mcp/main.js",
  "package/package.json",
  "package/scripts/rea.mjs",
  "package/skills/reverse-engineer-anything/SKILL.md",
];

const USAGE =
  "Usage: node scripts/continuity/build-retained-bundle.mjs --output DIR [--source DIR] [--submodule PATH] [--allow-dirty] [--json]";

try {
  const { values } = parseArgs({
    options: {
      output: { type: "string" },
      source: { type: "string", default: ROOT },
      submodule: {
        type: "string",
        multiple: true,
        default: ["third_party/wakaru"],
      },
      "allow-dirty": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
  } else {
    const output = resolve(requireValue(values.output, "--output"));
    const source = resolve(values.source);
    const build = await buildBundle({
      source,
      output,
      submodules: values.submodule,
      allowDirty: values["allow-dirty"],
    });
    process.stdout.write(`${JSON.stringify(build)}\n`);
  }
} catch (cause) {
  reportFailure(cause, USAGE);
}

async function buildBundle({ source, output, submodules, allowDirty }) {
  const packageJson = JSON.parse(
    await readFile(join(source, "package.json"), "utf8"),
  );
  if (
    typeof packageJson.engines?.node !== "string" ||
    !satisfies(process.version, packageJson.engines.node, {
      includePrerelease: true,
    })
  )
    throw new Error(
      `Node ${process.version} does not satisfy package engines ${String(packageJson.engines?.node)}`,
    );
  const status = await git(source, [
    "status",
    "--porcelain",
    "--untracked-files=normal",
  ]);
  if (status !== "" && allowDirty !== true)
    throw new Error(
      "Retained bundles require a clean source checkout; use --allow-dirty to record worktree provenance explicitly",
    );
  const sourceSha = await resolveCommit(source, "HEAD");
  const branch = await git(source, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const submoduleContent = await retainSubmodules(source, submodules);
  const parent = dirname(output);
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(join(parent, `.${basename(output)}-build-`));
  try {
    const packDirectory = join(temporary, ".pack");
    await mkdir(packDirectory);
    await runNpm(
      ["pack", "--silent", "--pack-destination", packDirectory],
      source,
    );
    const packed = (await readdir(packDirectory)).filter((name) =>
      name.endsWith(".tgz"),
    );
    if (packed.length !== 1)
      throw new Error(`npm pack produced ${String(packed.length)} archives`);
    const tarball = join(packDirectory, packed[0]);
    const packedFiles = await inspectTarArchive(tarball);
    for (const required of REQUIRED_PACKAGE_FILES)
      if (!packedFiles.includes(required))
        throw new Error(
          `${tarball} is missing ${required}; consumers would need a build`,
        );
    const packedManifest = JSON.parse(
      (
        await execute("tar", ["-xOf", tarball, "package/package.json"], {
          maxBuffer: MAX_BUFFER,
        })
      ).stdout,
    );
    if (
      packedManifest.name !== packageJson.name ||
      packedManifest.version !== packageJson.version
    )
      throw new Error(
        "Packed package identity differs from the checked-out package",
      );
    const vendorSkillPath = "skills/reverse-engineer-anything/SKILL.md";
    const vendorSkill = (
      await execute("tar", ["-xOzf", tarball, `package/${vendorSkillPath}`], {
        maxBuffer: MAX_BUFFER,
      })
    ).stdout;
    const vendorSkillVersion = skillVersion(vendorSkill);
    if (vendorSkillVersion === null)
      throw new Error("Packed vendor skill has no metadata version");
    await cp(tarball, join(temporary, "package.tgz"));
    await rm(packDirectory, { recursive: true, force: true });

    await git(source, [
      "archive",
      "--format=tar.gz",
      "--prefix=source/",
      "-o",
      join(temporary, "source.tar.gz"),
      "HEAD",
    ]);
    await mkdir(join(temporary, "submodules"), { recursive: true });
    for (const submodule of submoduleContent) {
      const archive = `submodules/${submodule.archiveName}`;
      await git(source, [
        "-C",
        submodule.path,
        "archive",
        "--format=tar.gz",
        "--prefix",
        `submodules/${submodule.path}/`,
        "-o",
        join(temporary, archive),
        "HEAD",
      ]);
      submodule.archive = archive;
    }

    const worktree = await retainWorktree(source, temporary, status !== "");
    const dependency = await retainDependencies(
      source,
      join(temporary, "dependencies"),
    );
    const licenses = await retainLicenses(
      source,
      dependency.packages,
      join(temporary, "licenses"),
    );
    const inventory = await writeBundleInventory(temporary, {
      exclude: [MANIFEST_NAME],
    });
    const manifest = {
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      kind: BUNDLE_KIND,
      createdAt: sourceDate(),
      producer: { name: "rea-continuity-bundle", version: "1" },
      package: {
        name: packageJson.name,
        version: packageJson.version,
        tarball: "package.tgz",
        sha256: await sha256File(join(temporary, "package.tgz")),
      },
      vendorSkill: {
        path: vendorSkillPath,
        version: vendorSkillVersion,
        sha256: await hashText(vendorSkill),
      },
      source: {
        sha: sourceSha,
        branch,
        clean: status === "",
        archive: "source.tar.gz",
        sha256: await sha256File(join(temporary, "source.tar.gz")),
        worktree,
        submodules: await Promise.all(
          submoduleContent.map(async (submodule) => ({
            path: submodule.path,
            sha: submodule.sha,
            archive: submodule.archive,
            sha256: await sha256File(join(temporary, submodule.archive)),
          })),
        ),
      },
      runtime: {
        node: process.version,
        npm: await npmVersion(source),
        platform: process.platform,
        architecture: process.arch,
      },
      compatibility: {
        node: process.version,
        engines: packageJson.engines.node,
        platform: process.platform,
        architecture: process.arch,
      },
      dependencies: {
        lockfileSha256: await sha256File(join(source, "package-lock.json")),
        packageCount: dependency.packageCount,
        roots: dependency.roots,
      },
      licenses: {
        notices: licenses.notices,
        dependencyNotices: licenses.dependencyNotices,
      },
      inventory,
    };
    assertBundleManifest(manifest);
    await writeFile(
      join(temporary, MANIFEST_NAME),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    const manifestSha256 = await sha256File(join(temporary, MANIFEST_NAME));
    await lstat(output).then(
      () => {
        throw new Error(`Output already exists: ${output}`);
      },
      (cause) => {
        if (cause?.code !== "ENOENT") throw cause;
      },
    );
    await rename(temporary, output);
    return {
      output,
      manifestSha256,
      package: manifest.package,
      source: manifest.source,
      runtime: manifest.runtime,
      dependencies: {
        roots: dependency.roots.length,
        packages: dependency.packageCount,
      },
      inventory: { files: inventory.files, bytes: inventory.bytes },
    };
  } catch (cause) {
    await rm(temporary, { recursive: true, force: true });
    throw cause;
  }
}

async function retainSubmodules(source, submodules) {
  const retained = [];
  for (const path of submodules) {
    if (path.split("/").some((segment) => !SAFE_SEGMENT.test(segment)))
      throw new UsageError(`Unsafe submodule path: ${path}`);
    const entry = await gitMaybe(source, ["ls-tree", "HEAD", "--", path]);
    const gitlink = /^160000 commit ([a-f0-9]{40})\t/u.exec(entry ?? "");
    if (gitlink === null)
      throw new Error(`${path} is not a pinned submodule at HEAD`);
    const actual = await gitMaybe(source, ["-C", path, "rev-parse", "HEAD"]);
    if (actual !== gitlink[1])
      throw new Error(
        `${path} content is missing or does not match its pinned revision ${gitlink[1]}`,
      );
    retained.push({
      path,
      sha: gitlink[1],
      archiveName: `${path.replaceAll("/", "__")}.tar.gz`,
    });
  }
  return retained;
}

async function retainWorktree(source, temporary, dirty) {
  if (!dirty) return null;
  const patch = (
    await execute("git", ["-C", source, "diff", "--binary", "HEAD"], {
      maxBuffer: MAX_BUFFER,
    })
  ).stdout;
  await writeFile(join(temporary, "source-worktree.patch"), patch, "utf8");
  const untracked = (
    await execute(
      "git",
      ["-C", source, "ls-files", "--others", "--exclude-standard"],
      { maxBuffer: MAX_BUFFER },
    )
  ).stdout
    .split("\n")
    .filter((file) => file.length > 0);
  for (const file of untracked)
    if (file.startsWith("/") || file.split("/").includes(".."))
      throw new Error(`Untracked source path is unsafe: ${file}`);
  const archive = join(temporary, "source-untracked.tar.gz");
  if (untracked.length > 0) {
    const list = join(temporary, ".untracked-files.txt");
    await writeFile(
      list,
      `${untracked.map((file) => `./${file}`).join("\n")}\n`,
      "utf8",
    );
    try {
      await execute("tar", ["-czf", archive, "-C", source, "-T", list], {
        maxBuffer: MAX_BUFFER,
      });
    } finally {
      await rm(list, { force: true });
    }
  } else {
    const empty = join(temporary, ".empty-untracked");
    await mkdir(empty);
    await execute("tar", ["-czf", archive, "-C", empty, "."], {
      maxBuffer: MAX_BUFFER,
    });
    await rm(empty, { recursive: true, force: true });
  }
  return {
    files: untracked,
    patch: "source-worktree.patch",
    patchSha256: await sha256File(join(temporary, "source-worktree.patch")),
    untracked: "source-untracked.tar.gz",
    untrackedSha256: await sha256File(archive),
  };
}

function skillVersion(skill) {
  const lines = skill.split("\n");
  const metadata = lines.findIndex((line) => line.trim() === "metadata:");
  if (metadata < 0) return null;
  const versionLine = lines
    .slice(metadata + 1)
    .find((line) => /^\s+version:\s*/u.test(line));
  if (versionLine === undefined) return null;
  return versionLine
    .replace(/^\s+version:\s*/u, "")
    .replaceAll('"', "")
    .trim();
}

function hashText(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function retainDependencies(source, destination) {
  const output = await runNpm(
    ["ls", "--omit=dev", "--all", "--parseable"],
    source,
  );
  const paths = output
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .filter((line) => line !== source);
  const packages = [];
  const seen = new Set();
  for (const path of paths) {
    const relativePath = relative(source, path);
    if (
      relativePath.startsWith("..") ||
      relativePath.includes("node_modules/.bin")
    )
      throw new Error(`npm ls returned an unexpected dependency path: ${path}`);
    if (seen.has(relativePath)) continue;
    seen.add(relativePath);
    const target = join(destination, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await cp(path, target, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      errorOnExist: true,
    });
    const metadata = JSON.parse(
      await readFile(join(target, "package.json"), "utf8"),
    );
    if (
      typeof metadata.name !== "string" ||
      valid(metadata.version) !== metadata.version
    )
      throw new Error(`Dependency metadata is incomplete: ${relativePath}`);
    packages.push({
      name: metadata.name,
      version: metadata.version,
      relativePath,
    });
  }
  if (packages.length === 0)
    throw new Error("No production dependencies were retained");
  const packageJson = JSON.parse(
    await readFile(join(source, "package.json"), "utf8"),
  );
  const required = new Set(Object.keys(packageJson.dependencies ?? {}));
  const optional = new Set(Object.keys(packageJson.optionalDependencies ?? {}));
  const roots = [];
  for (const name of [...new Set([...required, ...optional])].sort()) {
    const retained = packages.find(
      (candidate) =>
        candidate.name === name && seen.has(join("node_modules", name)),
    );
    if (retained === undefined) {
      if (optional.has(name) && !required.has(name)) continue;
      throw new Error(`Production dependency ${name} was not retained`);
    }
    roots.push({ name: retained.name, version: retained.version });
  }
  roots.sort((left, right) => left.name.localeCompare(right.name));
  await writeFile(
    join(destination, "package.json"),
    `${JSON.stringify(
      {
        name: "rea-continuity-dependencies",
        private: true,
        dependencies: Object.fromEntries(
          roots.map(({ name, version }) => [name, version]),
        ),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { roots, packages, packageCount: packages.length };
}

async function runNpm(args, cwd) {
  const npmCli = process.env.npm_execpath;
  const { stdout, stderr } = await execute(
    npmCli === undefined ? "npm" : process.execPath,
    npmCli === undefined ? args : [npmCli, ...args],
    {
      cwd,
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
      env: { ...process.env, npm_config_update_notifier: "false" },
    },
  ).catch((cause) => {
    throw new Error(
      `npm ${args.join(" ")} failed: ${sanitizeOutput(cause.stderr ?? "", cause.stdout ?? "")}`,
      { cause },
    );
  });
  if (stderr.length > 0) process.stderr.write(stderr);
  return stdout.trim();
}

async function npmVersion(cwd) {
  return await runNpm(["--version"], cwd);
}

function sourceDate() {
  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (epoch === undefined) return new Date().toISOString();
  if (!/^\d+$/u.test(epoch))
    throw new Error("SOURCE_DATE_EPOCH must be seconds");
  return new Date(Number(epoch) * 1000).toISOString();
}
