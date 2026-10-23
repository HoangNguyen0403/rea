import { assertSafeBundlePath } from "./bundle-fs.mjs";

export const BUNDLE_SCHEMA_VERSION = 1;
export const BUNDLE_KIND = "rea-continuity-bundle";

const TOP_LEVEL_KEYS = [
  "compatibility",
  "createdAt",
  "dependencies",
  "inventory",
  "kind",
  "licenses",
  "package",
  "producer",
  "runtime",
  "schemaVersion",
  "source",
  "vendorSkill",
];
const SHA40 = /^[a-f0-9]{40}$/u;
const SHA64 = /^[a-f0-9]{64}$/u;
// Display-shape validation only; dependency range satisfaction is owned by the
// retained package's own semver contract, not a partial recovery reimplementation.
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

/** Validate the complete manifest shape before trusting any nested value. */
export function assertBundleManifest(manifest) {
  assertExactKeys(manifest, TOP_LEVEL_KEYS, "manifest");
  if (manifest.schemaVersion !== BUNDLE_SCHEMA_VERSION)
    throw new Error("Unsupported continuity bundle schema version");
  if (manifest.kind !== BUNDLE_KIND)
    throw new Error("Continuity bundle kind is not recognized");
  assertIsoDate(manifest.createdAt, "manifest.createdAt");

  assertExactKeys(manifest.producer, ["name", "version"], "producer");
  assertNonEmptyString(manifest.producer.name, "producer.name");
  assertNonEmptyString(manifest.producer.version, "producer.version");

  assertExactKeys(
    manifest.package,
    ["name", "sha256", "tarball", "version"],
    "package",
  );
  assertNonEmptyString(manifest.package.name, "package.name");
  if (!VERSION.test(manifest.package.version))
    throw new Error("Continuity bundle package version is invalid");
  assertSafeBundlePath(manifest.package.tarball);
  assertDigest(manifest.package.sha256, "package.sha256");

  assertExactKeys(
    manifest.vendorSkill,
    ["path", "sha256", "version"],
    "vendorSkill",
  );
  assertSafeBundlePath(manifest.vendorSkill.path);
  assertDigest(manifest.vendorSkill.sha256, "vendorSkill.sha256");
  assertNonEmptyString(manifest.vendorSkill.version, "vendorSkill.version");

  assertExactKeys(
    manifest.source,
    ["archive", "branch", "clean", "sha", "sha256", "submodules", "worktree"],
    "source",
  );
  assertSha40(manifest.source.sha, "source.sha");
  assertNonEmptyString(manifest.source.branch, "source.branch");
  if (typeof manifest.source.clean !== "boolean")
    throw new Error("Continuity bundle source clean flag must be boolean");
  assertSafeBundlePath(manifest.source.archive);
  assertDigest(manifest.source.sha256, "source.sha256");
  if (manifest.source.clean) {
    if (manifest.source.worktree !== null)
      throw new Error("Clean source must not carry a worktree overlay");
  } else {
    assertExactKeys(
      manifest.source.worktree,
      ["files", "patch", "patchSha256", "untracked", "untrackedSha256"],
      "source.worktree",
    );
    if (!Array.isArray(manifest.source.worktree.files))
      throw new Error("Dirty source must list its worktree files");
    for (const file of manifest.source.worktree.files)
      assertNonEmptyString(file, "source.worktree.files[]");
    assertSafeBundlePath(manifest.source.worktree.patch);
    assertDigest(
      manifest.source.worktree.patchSha256,
      "source.worktree.patchSha256",
    );
    assertSafeBundlePath(manifest.source.worktree.untracked);
    assertDigest(
      manifest.source.worktree.untrackedSha256,
      "source.worktree.untrackedSha256",
    );
  }
  if (
    !Array.isArray(manifest.source.submodules) ||
    manifest.source.submodules.length === 0
  )
    throw new Error("Continuity bundle must retain source submodule content");
  for (const [index, submodule] of manifest.source.submodules.entries()) {
    assertExactKeys(
      submodule,
      ["archive", "path", "sha", "sha256"],
      `source.submodules[${String(index)}]`,
    );
    assertSafeBundlePath(submodule.path);
    assertSha40(submodule.sha, `source.submodules[${String(index)}].sha`);
    assertSafeBundlePath(submodule.archive);
    assertDigest(
      submodule.sha256,
      `source.submodules[${String(index)}].sha256`,
    );
  }

  assertExactKeys(
    manifest.runtime,
    ["architecture", "node", "npm", "platform"],
    "runtime",
  );
  for (const key of ["architecture", "node", "npm", "platform"])
    assertNonEmptyString(manifest.runtime[key], `runtime.${key}`);

  assertExactKeys(
    manifest.compatibility,
    ["architecture", "engines", "node", "platform"],
    "compatibility",
  );
  for (const key of ["architecture", "engines", "node", "platform"])
    assertNonEmptyString(manifest.compatibility[key], `compatibility.${key}`);
  for (const key of ["architecture", "node", "platform"])
    if (manifest.runtime[key] !== manifest.compatibility[key])
      throw new Error(
        `Continuity bundle runtime and compatibility ${key} differ`,
      );

  assertExactKeys(
    manifest.dependencies,
    ["lockfileSha256", "packageCount", "roots"],
    "dependencies",
  );
  assertDigest(
    manifest.dependencies.lockfileSha256,
    "dependencies.lockfileSha256",
  );
  if (
    !Number.isSafeInteger(manifest.dependencies.packageCount) ||
    manifest.dependencies.packageCount <= 0
  )
    throw new Error(
      "Continuity bundle dependency package count must be positive",
    );
  if (
    !Array.isArray(manifest.dependencies.roots) ||
    manifest.dependencies.roots.length === 0
  )
    throw new Error(
      "Continuity bundle must retain production dependency roots",
    );
  const rootNames = new Set();
  for (const [index, root] of manifest.dependencies.roots.entries()) {
    assertExactKeys(
      root,
      ["name", "version"],
      `dependencies.roots[${String(index)}]`,
    );
    assertNonEmptyString(
      root.name,
      `dependencies.roots[${String(index)}].name`,
    );
    if (!VERSION.test(root.version))
      throw new Error(`Dependency root ${root.name} has an invalid version`);
    if (rootNames.has(root.name))
      throw new Error(`Continuity bundle repeats dependency root ${root.name}`);
    rootNames.add(root.name);
  }

  assertExactKeys(
    manifest.licenses,
    ["dependencyNotices", "notices"],
    "licenses",
  );
  if (
    !Number.isSafeInteger(manifest.licenses.dependencyNotices) ||
    manifest.licenses.dependencyNotices <= 0
  )
    throw new Error("Continuity bundle dependency license notices are missing");
  if (
    !Array.isArray(manifest.licenses.notices) ||
    manifest.licenses.notices.length === 0
  )
    throw new Error("Continuity bundle source license notices are missing");
  for (const path of manifest.licenses.notices) assertSafeBundlePath(path);

  assertExactKeys(
    manifest.inventory,
    ["bytes", "files", "path", "sha256"],
    "inventory",
  );
  if (manifest.inventory.path !== "inventory.jsonl")
    throw new Error("Continuity bundle inventory path is not canonical");
  if (
    !Number.isSafeInteger(manifest.inventory.files) ||
    manifest.inventory.files <= 0
  )
    throw new Error("Continuity bundle inventory file count must be positive");
  if (
    !Number.isSafeInteger(manifest.inventory.bytes) ||
    manifest.inventory.bytes <= 0
  )
    throw new Error("Continuity bundle inventory byte count must be positive");
  assertDigest(manifest.inventory.sha256, "inventory.sha256");
  return manifest;
}

/** Reject a bundle built for another platform or an unsupported Node runtime. */
export function assertBundleCompatibility(
  manifest,
  {
    platform = process.platform,
    architecture = process.arch,
    nodeVersion = process.version,
    allowForeignPlatform = false,
  } = {},
) {
  if (
    !allowForeignPlatform &&
    (manifest.compatibility.platform !== platform ||
      manifest.compatibility.architecture !== architecture)
  )
    throw new Error(
      `Continuity bundle targets ${manifest.compatibility.platform}/${manifest.compatibility.architecture} with Node ${manifest.compatibility.node}; this host is ${platform}/${architecture} with Node ${nodeVersion}`,
    );
  if (manifest.compatibility.node !== nodeVersion)
    throw new Error(
      `Continuity bundle requires the exact build Node ${manifest.compatibility.node}; this host is ${nodeVersion}`,
    );
}

function assertExactKeys(value, expected, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    keys.length !== wanted.length ||
    keys.some((key, index) => key !== wanted[index])
  )
    throw new Error(`${label} has missing or unknown fields`);
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${label} must be a non-empty string`);
}

function assertDigest(value, label) {
  if (typeof value !== "string" || !SHA64.test(value))
    throw new Error(`${label} must be a SHA-256 digest`);
}

function assertSha40(value, label) {
  if (typeof value !== "string" || !SHA40.test(value))
    throw new Error(`${label} must be a full commit SHA`);
}

function assertIsoDate(value, label) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)))
    throw new Error(`${label} must be an ISO timestamp`);
}
