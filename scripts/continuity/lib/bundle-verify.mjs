import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";

import { satisfies, valid, validRange } from "semver";

import {
  MANIFEST_NAME,
  INVENTORY_NAME,
  parseBundleInventory,
  sha256File,
  walkBundleFiles,
} from "./bundle-fs.mjs";
import {
  assertBundleCompatibility,
  assertBundleManifest,
} from "./bundle-manifest.mjs";
import { inspectTarArchive } from "./tar-safety.mjs";

const execute = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

/** Verify every retained byte and the actual dependency closure it restores. */
export async function verifyRetainedBundle(
  root,
  {
    expectedManifestSha256,
    platform = process.platform,
    architecture = process.arch,
    nodeVersion = process.version,
    allowForeignPlatform = false,
  } = {},
) {
  if (
    typeof expectedManifestSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(expectedManifestSha256)
  )
    throw new Error(
      "A trusted manifest SHA-256 is required before verification",
    );
  const info = await lstat(root);
  if (!info.isDirectory())
    throw new Error("Continuity bundle must be an extracted directory");
  const manifestBytes = await readFile(join(root, MANIFEST_NAME));
  if (sha256(manifestBytes) !== expectedManifestSha256)
    throw new Error(
      "Continuity bundle manifest digest does not match the externally trusted digest",
    );
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch (cause) {
    throw new Error(
      "Continuity bundle manifest is malformed after authentication",
      {
        cause,
      },
    );
  }
  const inventoryText = await readFile(join(root, INVENTORY_NAME), "utf8");
  assertBundleManifest(manifest);
  assertBundleCompatibility(manifest, {
    platform,
    architecture,
    nodeVersion,
    allowForeignPlatform,
  });

  const inventorySha = await sha256File(join(root, INVENTORY_NAME));
  if (inventorySha !== manifest.inventory.sha256)
    throw new Error("Continuity bundle inventory digest mismatch");
  const entries = parseBundleInventory(inventoryText);
  if (
    entries.length !== manifest.inventory.files ||
    entries.reduce((total, entry) => total + entry.bytes, 0) !==
      manifest.inventory.bytes
  )
    throw new Error(
      "Continuity bundle inventory counts do not match its manifest",
    );

  const files = await walkBundleFiles(root, {
    exclude: [MANIFEST_NAME, INVENTORY_NAME],
  });
  const actual = new Map(files.map((file) => [file.path, file]));
  if (actual.size !== entries.length)
    throw new Error(
      "Continuity bundle contains files absent from its inventory",
    );
  const inventoryPaths = new Set();
  for (const entry of entries) {
    const file = actual.get(entry.path);
    if (file === undefined)
      throw new Error(`Continuity bundle is missing ${entry.path}`);
    inventoryPaths.add(entry.path);
    const infoForFile = await lstat(file.absolute);
    if (infoForFile.size !== entry.bytes)
      throw new Error(`Continuity bundle size mismatch for ${entry.path}`);
    if ((await sha256File(file.absolute)) !== entry.sha256)
      throw new Error(`Continuity bundle digest mismatch for ${entry.path}`);
  }
  for (const path of actual.keys())
    if (!inventoryPaths.has(path))
      throw new Error(`Continuity bundle contains unlisted file ${path}`);

  assertInventoryDigest(
    entries,
    manifest.package.tarball,
    manifest.package.sha256,
    "package archive",
  );
  assertInventoryDigest(
    entries,
    manifest.source.archive,
    manifest.source.sha256,
    "source archive",
  );
  for (const submodule of manifest.source.submodules)
    assertInventoryDigest(
      entries,
      submodule.archive,
      submodule.sha256,
      `submodule archive ${submodule.path}`,
    );
  for (const notice of manifest.licenses.notices) assertListed(entries, notice);
  if (!manifest.source.clean) {
    assertInventoryDigest(
      entries,
      manifest.source.worktree.patch,
      manifest.source.worktree.patchSha256,
      "source worktree patch",
    );
    assertInventoryDigest(
      entries,
      manifest.source.worktree.untracked,
      manifest.source.worktree.untrackedSha256,
      "source untracked archive",
    );
  }

  const packed = await verifyPackageArchive(root, manifest);
  const dependencySummary = await verifyDependencies(
    root,
    entries,
    manifest,
    packed,
  );
  await verifyLicenses(root, entries, manifest);
  return {
    package: {
      name: manifest.package.name,
      version: manifest.package.version,
      sha256: manifest.package.sha256,
    },
    source: {
      sha: manifest.source.sha,
      clean: manifest.source.clean,
      submodules: manifest.source.submodules.map(({ path, sha }) => ({
        path,
        sha,
      })),
    },
    runtime: manifest.runtime,
    compatibility: manifest.compatibility,
    inventory: manifest.inventory,
    dependencies: dependencySummary,
  };
}

async function verifyPackageArchive(root, manifest) {
  const tarball = join(root, manifest.package.tarball);
  const listing = await inspectTarArchive(tarball);
  for (const member of listing)
    if (!member.startsWith("package/"))
      throw new Error(
        `Retained package archive has an unsafe member: ${member}`,
      );
  const required = [
    "package/dist/mcp/main.js",
    "package/package.json",
    "package/scripts/rea.mjs",
    `package/${manifest.vendorSkill.path}`,
  ];
  for (const member of required)
    if (!listing.includes(member))
      throw new Error(`Retained package archive is missing ${member}`);
  const packedPackage = JSON.parse(
    await extractMember(tarball, "package/package.json"),
  );
  if (
    packedPackage.name !== manifest.package.name ||
    packedPackage.version !== manifest.package.version
  )
    throw new Error(
      "Retained package archive identity differs from its manifest",
    );
  const skill = await extractMember(
    tarball,
    `package/${manifest.vendorSkill.path}`,
  );
  if (sha256(Buffer.from(skill)) !== manifest.vendorSkill.sha256)
    throw new Error("Retained package vendor skill digest mismatch");
  const version = skillVersion(skill);
  if (version !== manifest.vendorSkill.version)
    throw new Error(
      `Retained package vendor skill version ${String(version)} differs from ${manifest.vendorSkill.version}`,
    );
  return {
    dependencies: packedPackage.dependencies ?? {},
    optionalDependencies: packedPackage.optionalDependencies ?? {},
  };
}

async function extractMember(tarball, member) {
  return (
    await execute("tar", ["-xOzf", tarball, member], {
      maxBuffer: MAX_BUFFER,
    })
  ).stdout;
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertListed(entries, path) {
  if (!entries.some((entry) => entry.path === path))
    throw new Error(
      `Continuity bundle did not inventory required file ${path}`,
    );
}

function assertInventoryDigest(entries, path, expected, label) {
  const entry = entries.find((candidate) => candidate.path === path);
  if (entry === undefined)
    throw new Error(
      `Continuity bundle did not inventory required file ${path}`,
    );
  if (entry.sha256 !== expected)
    throw new Error(`Continuity bundle ${label} digest differs from ${path}`);
}

async function verifyDependencies(root, entries, manifest, packed) {
  const dependenciesRoot = join(root, "dependencies");
  const packageJsonPath = "dependencies/package.json";
  const metadataPath = join(root, packageJsonPath);
  assertListed(entries, packageJsonPath);
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  if (
    metadata?.private !== true ||
    typeof metadata?.dependencies !== "object" ||
    metadata.dependencies === null
  )
    throw new Error("Continuity bundle dependency manifest is invalid");
  const expected = new Map(
    manifest.dependencies.roots.map(({ name, version }) => [name, version]),
  );
  const declared = new Map(Object.entries(metadata.dependencies));
  if (declared.size !== expected.size)
    throw new Error(
      "Continuity bundle dependency roots differ from its manifest",
    );
  for (const [name, version] of expected) {
    if (declared.get(name) !== version)
      throw new Error(`Continuity bundle dependency root mismatch for ${name}`);
    const packagePath = join(
      dependenciesRoot,
      "node_modules",
      name,
      "package.json",
    );
    const relativePackagePath = toBundlePath(root, packagePath);
    assertListed(entries, relativePackagePath);
    const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
    if (packageJson.name !== name || packageJson.version !== version)
      throw new Error(
        `Continuity bundle retained the wrong package for ${name}`,
      );
  }

  const required = new Map(Object.entries(packed.dependencies));
  const optional = new Map(Object.entries(packed.optionalDependencies));
  for (const name of required.keys())
    if (!expected.has(name))
      throw new Error(
        `Continuity bundle omitted packed required dependency ${name}`,
      );
  for (const [name, version] of expected) {
    if (!required.has(name) && !optional.has(name))
      throw new Error(
        `Continuity bundle retained undeclared dependency ${name}`,
      );
    const range = required.get(name) ?? optional.get(name);
    assertRangeSatisfied(`packed root ${name}`, version, range);
  }

  const packageFiles = await walkBundleFiles(dependenciesRoot);
  const packageDirectories = new Map();
  for (const file of packageFiles) {
    const segments = file.path.split("/");
    if (segments.at(-1) !== "package.json") continue;
    const nodeModules = segments.lastIndexOf("node_modules");
    if (nodeModules === -1) continue;
    const packagePath = segments.slice(nodeModules + 1, -1);
    if (
      packagePath.length !== 1 &&
      !(packagePath.length === 2 && packagePath[0].startsWith("@"))
    )
      continue;
    const packageJson = JSON.parse(await readFile(file.absolute, "utf8"));
    const expectedName =
      packagePath.length === 1
        ? packagePath[0]
        : `${packagePath[0]}/${packagePath[1]}`;
    if (
      packageJson.name !== expectedName ||
      valid(packageJson.version) !== packageJson.version
    )
      throw new Error(
        `Retained dependency metadata is incomplete: ${file.path}`,
      );
    packageDirectories.set(dirname(file.absolute), packageJson);
  }
  if (packageDirectories.size !== manifest.dependencies.packageCount)
    throw new Error(
      "Continuity bundle dependency package count differs from its manifest",
    );
  for (const [packageDirectory, packageJson] of packageDirectories) {
    for (const [name, range] of Object.entries(
      packageJson.dependencies ?? {},
    )) {
      const resolved = await resolveDependency(
        dependenciesRoot,
        packageDirectory,
        name,
      );
      if (resolved === null)
        throw new Error(
          `Continuity bundle omitted ${name}, required by ${packageJson.name}@${packageJson.version}`,
        );
      const resolvedPackage = JSON.parse(await readFile(resolved, "utf8"));
      if (resolvedPackage.name !== name)
        throw new Error(
          `Continuity bundle retained the wrong package for ${name}`,
        );
      assertRangeSatisfied(
        `${name} resolved by ${packageJson.name}@${packageJson.version}`,
        resolvedPackage.version,
        range,
      );
    }
    for (const [name, range] of Object.entries(
      packageJson.optionalDependencies ?? {},
    )) {
      const resolved = await resolveDependency(
        dependenciesRoot,
        packageDirectory,
        name,
      );
      if (resolved === null) continue;
      const resolvedPackage = JSON.parse(await readFile(resolved, "utf8"));
      if (resolvedPackage.name !== name)
        throw new Error(
          `Continuity bundle retained the wrong package for ${name}`,
        );
      assertRangeSatisfied(
        `optional ${name} resolved by ${packageJson.name}@${packageJson.version}`,
        resolvedPackage.version,
        range,
      );
    }
  }
  return {
    roots: [...expected.keys()].sort(),
    optionalAbsent: [...optional.keys()]
      .filter((name) => !expected.has(name))
      .sort(),
    packages: packageDirectories.size,
    files: packageFiles.length,
  };
}

function assertRangeSatisfied(label, version, range) {
  if (valid(version) !== version)
    throw new Error(
      `Continuity bundle retained invalid version ${version} for ${label}`,
    );
  if (typeof range !== "string" || validRange(range) === null)
    throw new Error(
      `Continuity bundle cannot evaluate dependency range for ${label}`,
    );
  if (!satisfies(version, range, { includePrerelease: true }))
    throw new Error(
      `Continuity bundle version ${version} for ${label} does not satisfy ${range}`,
    );
}

async function resolveDependency(dependenciesRoot, packageDirectory, name) {
  let directory = packageDirectory;
  while (true) {
    if (basename(directory) !== "node_modules") {
      const candidate = join(directory, "node_modules", name, "package.json");
      try {
        await lstat(candidate);
        return candidate;
      } catch {
        // Continue at the next Node resolution root.
      }
    }
    if (directory === dependenciesRoot) return null;
    const parent = dirname(directory);
    if (parent === directory || !parent.startsWith(dependenciesRoot))
      return null;
    directory = parent;
  }
}

async function verifyLicenses(root, entries, manifest) {
  const dependencyFiles = (
    await walkBundleFiles(join(root, "licenses", "dependencies"))
  ).filter((file) => file.path.length > 0);
  if (dependencyFiles.length !== manifest.licenses.dependencyNotices)
    throw new Error(
      "Continuity bundle dependency license notice count is wrong",
    );
  for (const file of dependencyFiles)
    assertListed(entries, `licenses/dependencies/${file.path}`);
}

const toBundlePath = (root, path) => relative(root, path).split(sep).join("/");
