import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  link,
  mkdir,
  readFile,
  readdir,
  rename as fsRename,
  rm as fsRm,
  symlink,
  writeFile,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { writeBundleInventory } from "../../../scripts/continuity/lib/bundle-fs.mjs";
import { retainLicenses } from "../../../scripts/continuity/lib/license-retention.mjs";
import {
  restoreRetainedBundle,
  rollbackRetainedInstall,
} from "../../../scripts/continuity/lib/restore.mjs";
import type { ContinuityFileSystem } from "../../../scripts/continuity/lib/restore.mjs";

const execute = promisify(execFile);
const ROOT = join(import.meta.dirname, "../../..");
const SCRIPT = (name: string) => join(ROOT, "scripts/continuity", name);
const SOURCE_SHA = "a".repeat(40);
const SUBMODULE_SHA = "b".repeat(40);

type BundleOptions = {
  omitDependencies?: boolean;
  missingTransitive?: boolean;
  omitPackedRoot?: boolean;
  incompatibleTransitive?: boolean;
  internalPackageMetadata?: boolean;
  scopedNestedDependency?: boolean;
  linkMember?: "symlink" | "hardlink";
  platform?: string;
  architecture?: string;
  rootVersion?: string;
  traversal?: boolean;
  corrupt?: boolean;
};

type BundleFixture = {
  root: string;
  bundle: string;
  manifestSha256: string;
};
it("accepts a fully retained bundle with its actual dependency closure", async () => {
  const fixture = await createFixture();

  const result = await run("verify-retained-bundle.mjs", [
    fixture.bundle,
    "--manifest-sha256",
    fixture.manifestSha256,
  ]);

  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    package: { version: "1.0.0" },
    dependencies: { roots: ["left-pad"], packages: 2 },
  });
});

it("returns the schema-shaped inventory summary used by bundle manifests", async () => {
  const directory = await createTestTempDirectory("rea-continuity-inventory-");
  await writeFile(join(directory, "payload.txt"), "proof\n");

  const inventory = await writeBundleInventory(directory);

  expect(inventory).toEqual({
    path: "inventory.jsonl",
    sha256: await hash(join(directory, "inventory.jsonl")),
    files: 1,
    bytes: Buffer.byteLength("proof\n"),
  });
});

it("retains notices for duplicate package identities at distinct physical paths", async () => {
  const root = await createTestTempDirectory("rea-continuity-licenses-");
  const source = join(root, "source");
  const destination = join(root, "retained", "licenses");
  const packages = [
    {
      name: "left-pad",
      version: "1.0.0",
      relativePath: "node_modules/left-pad",
      notice: "root left-pad notice\n",
    },
    {
      name: "container",
      version: "2.0.0",
      relativePath: "node_modules/container",
      notice: "container notice\n",
    },
    {
      name: "left-pad",
      version: "1.0.0",
      relativePath: "node_modules/container/node_modules/left-pad",
      notice: "nested left-pad notice\n",
    },
  ];
  await mkdir(source, { recursive: true });
  for (const packageEntry of packages) {
    const packageRoot = join(source, packageEntry.relativePath);
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      `${JSON.stringify({ name: packageEntry.name, version: packageEntry.version })}\n`,
    );
    await writeFile(join(packageRoot, "LICENSE"), packageEntry.notice);
  }

  const retained = await retainLicenses(source, packages, destination);
  const retainedLicensePaths = packages.map((packageEntry) =>
    join(destination, "dependencies", packageEntry.relativePath, "LICENSE"),
  );

  expect(retained.dependencyNotices).toBe(3);
  expect(await countRegularFiles(join(destination, "dependencies"))).toBe(
    retained.dependencyNotices,
  );
  expect(
    await Promise.all(
      retainedLicensePaths.map((path) => readFile(path, "utf8")),
    ),
  ).toEqual(packages.map(({ notice }) => notice));
});
it("counts package roots, not package-internal metadata, including scoped nested roots", async () => {
  const fixture = await createFixture({
    internalPackageMetadata: true,
    scopedNestedDependency: true,
  });

  const result = await run("verify-retained-bundle.mjs", [
    fixture.bundle,
    "--manifest-sha256",
    fixture.manifestSha256,
  ]);

  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).dependencies.packages).toBe(3);
});

it("rejects a retained dependency whose bytes changed", async () => {
  const fixture = await createFixture({ corrupt: true });

  const result = await run("verify-retained-bundle.mjs", [
    fixture.bundle,
    "--manifest-sha256",
    fixture.manifestSha256,
  ]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("mismatch");
});

it("rejects manifest tampering after the bundle was built", async () => {
  const fixture = await createFixture();
  const manifestPath = join(fixture.bundle, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.package.sha256 = "c".repeat(64);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const result = await run("verify-retained-bundle.mjs", [
    fixture.bundle,
    "--manifest-sha256",
    fixture.manifestSha256,
  ]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("trusted");
});

it("rejects a bundle that retained only lockfile-shaped metadata", async () => {
  const fixture = await createFixture({ omitDependencies: true });

  const result = await run("verify-retained-bundle.mjs", [
    fixture.bundle,
    "--manifest-sha256",
    fixture.manifestSha256,
  ]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("production dependency roots");
});

it("rejects a bundle that omitted a transitive dependency", async () => {
  const fixture = await createFixture({ missingTransitive: true });

  const result = await run("verify-retained-bundle.mjs", [
    fixture.bundle,
    "--manifest-sha256",
    fixture.manifestSha256,
  ]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("omitted inner");
});

it("rejects foreign platform compatibility unless inspection is explicit", async () => {
  const fixture = await createFixture({
    platform: "linux",
    architecture: "x64",
  });

  expect(
    (
      await run("verify-retained-bundle.mjs", [
        fixture.bundle,
        "--manifest-sha256",
        fixture.manifestSha256,
      ])
    ).code,
  ).toBe(1);
  const inspection = await run("verify-retained-bundle.mjs", [
    fixture.bundle,
    "--manifest-sha256",
    fixture.manifestSha256,
    "--allow-foreign-platform",
  ]);
  expect(inspection.code).toBe(0);
});

it("rejects an inventory path that escapes the bundle root", async () => {
  const fixture = await createFixture({ traversal: true });

  const result = await run("verify-retained-bundle.mjs", [
    fixture.bundle,
    "--manifest-sha256",
    fixture.manifestSha256,
  ]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Unsafe bundle path");
});

it("restores offline, preserves the previous install, and rolls back", async () => {
  const fixture = await createFixture();
  const install = join(fixture.root, ".rea-continuity");
  await mkdir(install);
  await writeFile(join(install, "previous.txt"), "previous install\n");

  const restored = await run("restore-retained-bundle.mjs", [
    "--bundle",
    fixture.bundle,
    "--install-dir",
    install,
    "--manifest-sha256",
    fixture.manifestSha256,
    "--replace",
  ]);
  expect(restored.code).toBe(0);
  const restoreResult = JSON.parse(restored.stdout);
  expect(restoreResult.previousInstall).toContain(".previous-");
  expect(
    await readFile(join(restoreResult.previousInstall, "previous.txt"), "utf8"),
  ).toBe("previous install\n");
  const executed = await execute(process.execPath, [
    join(install, "scripts/rea.mjs"),
  ]);
  expect(JSON.parse(executed.stdout)).toMatchObject({ dependency: "1.0.0" });
  expect(
    JSON.parse(
      await readFile(join(install, "continuity-install.json"), "utf8"),
    ),
  ).toMatchObject({
    kind: "rea-continuity-install",
    package: { version: "1.0.0" },
  });

  const rolledBack = await run("rollback-retained-install.mjs", [
    "--install-dir",
    install,
  ]);
  expect(rolledBack.code).toBe(0);
  expect(await readFile(join(install, "previous.txt"), "utf8")).toBe(
    "previous install\n",
  );
});

it("refuses to replace an existing install without explicit authorization", async () => {
  const fixture = await createFixture();
  const install = join(fixture.root, "install");
  await mkdir(install);
  await writeFile(join(install, "previous.txt"), "previous install\n");

  const result = await run("restore-retained-bundle.mjs", [
    "--bundle",
    fixture.bundle,
    "--install-dir",
    install,
    "--manifest-sha256",
    fixture.manifestSha256,
  ]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("--replace");
  expect(await readFile(join(install, "previous.txt"), "utf8")).toBe(
    "previous install\n",
  );
});

it("refuses restore of a foreign platform bundle", async () => {
  const fixture = await createFixture({
    platform: "linux",
    architecture: "x64",
  });

  const result = await run("restore-retained-bundle.mjs", [
    "--bundle",
    fixture.bundle,
    "--install-dir",
    join(fixture.root, "foreign-install"),
    "--manifest-sha256",
    fixture.manifestSha256,
  ]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("targets linux/x64");
});

it("requires an externally trusted manifest digest", async () => {
  const fixture = await createFixture();

  const result = await run("verify-retained-bundle.mjs", [fixture.bundle]);

  expect(result.code).toBe(2);
  expect(result.stderr).toContain("--manifest-sha256");
});

it("rejects changed dependencies even when the candidate manifest is rehashed", async () => {
  const fixture = await createFixture();
  await writeFile(
    join(fixture.bundle, "dependencies/node_modules/left-pad/index.js"),
    "module.exports = 'changed';\n",
  );
  const inventory = await createInventory(fixture.bundle, false);
  await writeFile(join(fixture.bundle, "inventory.jsonl"), inventory.text);
  const manifestPath = join(fixture.bundle, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.inventory = {
    ...manifest.inventory,
    sha256: createHash("sha256").update(inventory.text).digest("hex"),
    files: inventory.count,
    bytes: inventory.bytes,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const result = await run("verify-retained-bundle.mjs", [
    fixture.bundle,
    "--manifest-sha256",
    fixture.manifestSha256,
  ]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("trusted digest");
});

it("rejects a packed required root that was not retained", async () => {
  const fixture = await createFixture({ omitPackedRoot: true });

  const result = await run("verify-retained-bundle.mjs", [
    fixture.bundle,
    "--manifest-sha256",
    fixture.manifestSha256,
  ]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("packed required dependency required-root");
});

it("rejects a transitive version outside its declared range", async () => {
  const fixture = await createFixture({ incompatibleTransitive: true });

  const result = await run("verify-retained-bundle.mjs", [
    fixture.bundle,
    "--manifest-sha256",
    fixture.manifestSha256,
  ]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("does not satisfy ^2.0.0");
});

it("rejects archive links before extraction", async () => {
  const fixture = await createFixture({ linkMember: "symlink" });

  const result = await run("verify-retained-bundle.mjs", [
    fixture.bundle,
    "--manifest-sha256",
    fixture.manifestSha256,
  ]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("not a regular file or directory");
});

it("rejects a sidecar symlink without moving the previous install", async () => {
  const fixture = await createFixture();
  const install = join(fixture.root, "install");
  const sentinel = join(fixture.root, "sidecar-target.json");
  await mkdir(install);
  await writeFile(join(install, "previous.txt"), "previous install\n");
  await writeFile(sentinel, "unrelated\n");
  await symlink(sentinel, `${install}.continuity-previous.json`);

  const result = await run("restore-retained-bundle.mjs", [
    "--bundle",
    fixture.bundle,
    "--install-dir",
    install,
    "--manifest-sha256",
    fixture.manifestSha256,
    "--replace",
  ]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("not a regular file");
  expect(await readFile(join(install, "previous.txt"), "utf8")).toBe(
    "previous install\n",
  );
  expect(await readFile(sentinel, "utf8")).toBe("unrelated\n");
});

it("restores the prior install and sidecar when activation fails", async () => {
  const fixture = await createFixture();
  const install = join(fixture.root, "install");
  const sidecar = `${install}.continuity-previous.json`;
  const oldSidecar = JSON.stringify({
    schemaVersion: 1,
    installDirectory: install,
    previousInstall: null,
  });
  await mkdir(install);
  await writeFile(join(install, "previous.txt"), "previous install\n");
  await writeFile(sidecar, oldSidecar);
  const filesystem: ContinuityFileSystem = {
    rename: async (source, destination) => {
      if (source.includes("-restore-") && destination === install)
        throw new Error("activation fault");
      return fsRename(source, destination);
    },
    rm: fsRm,
    writeFile: fsWriteFile,
  };

  await expect(
    restoreRetainedBundle({
      bundle: fixture.bundle,
      installDirectory: install,
      expectedManifestSha256: fixture.manifestSha256,
      replace: true,
      filesystem,
    }),
  ).rejects.toThrow("activation fault");
  expect(await readFile(join(install, "previous.txt"), "utf8")).toBe(
    "previous install\n",
  );
  expect(await readFile(sidecar, "utf8")).toBe(oldSidecar);
});

it("restores the prior install and sidecar when sidecar publication fails", async () => {
  const fixture = await createFixture();
  const install = join(fixture.root, "install");
  const sidecar = `${install}.continuity-previous.json`;
  const oldSidecar = JSON.stringify({
    schemaVersion: 1,
    installDirectory: install,
    previousInstall: null,
  });
  await mkdir(install);
  await writeFile(join(install, "previous.txt"), "previous install\n");
  await writeFile(sidecar, oldSidecar);
  const filesystem: ContinuityFileSystem = {
    rename: async (source, destination) => {
      if (source.includes("-sidecar-") && destination === sidecar)
        throw new Error("sidecar publication fault");
      return fsRename(source, destination);
    },
    rm: fsRm,
    writeFile: fsWriteFile,
  };

  await expect(
    restoreRetainedBundle({
      bundle: fixture.bundle,
      installDirectory: install,
      expectedManifestSha256: fixture.manifestSha256,
      replace: true,
      filesystem,
    }),
  ).rejects.toThrow("sidecar publication fault");
  expect(await readFile(join(install, "previous.txt"), "utf8")).toBe(
    "previous install\n",
  );
  expect(await readFile(sidecar, "utf8")).toBe(oldSidecar);
});

it("stages rollback metadata before moving either install", async () => {
  const fixture = await createFixture();
  const { install, record, sidecar, oldSidecar } =
    await createRestoredInstall(fixture);
  const filesystem: ContinuityFileSystem = {
    rename: fsRename,
    rm: fsRm,
    writeFile: async (path, data, options) => {
      if (path.includes(".tmp-")) throw new Error("rollback metadata fault");
      return fsWriteFile(path, data, options);
    },
  };

  await expect(
    rollbackRetainedInstall({ installDirectory: install, filesystem }),
  ).rejects.toThrow("rollback metadata fault");
  expect(
    await readFile(join(install, "continuity-install.json"), "utf8"),
  ).toContain('"kind": "rea-continuity-install"');
  expect(
    await readFile(join(record.previousInstall, "previous.txt"), "utf8"),
  ).toBe("previous install\n");
  expect(await readFile(sidecar, "utf8")).toBe(oldSidecar);
});

it("compensates a failed rollback sidecar publication without losing either install", async () => {
  const fixture = await createFixture();
  const { install, record, sidecar } = await createRestoredInstall(fixture);
  const filesystem: ContinuityFileSystem = {
    rename: async (source, destination) => {
      if (source.includes(".tmp-") && destination === sidecar)
        throw new Error("rollback sidecar fault");
      return fsRename(source, destination);
    },
    rm: fsRm,
    writeFile: fsWriteFile,
  };

  await expect(
    rollbackRetainedInstall({ installDirectory: install, filesystem }),
  ).rejects.toThrow("rollback sidecar fault");
  expect(
    await readFile(join(install, "continuity-install.json"), "utf8"),
  ).toContain('"kind": "rea-continuity-install"');
  expect(
    await readFile(join(record.previousInstall, "previous.txt"), "utf8"),
  ).toBe("previous install\n");
  expect(JSON.parse(await readFile(sidecar, "utf8"))).toEqual(record);
});

it("reports recovery locations and retains both installs after compensation failure", async () => {
  const fixture = await createFixture();
  const { install, record, sidecar } = await createRestoredInstall(fixture);
  const filesystem: ContinuityFileSystem = {
    rename: async (source, destination) => {
      if (source === install && destination === record.previousInstall)
        throw new Error("rollback compensation fault");
      if (source.includes(".tmp-") && destination === sidecar)
        throw new Error("rollback sidecar fault");
      return fsRename(source, destination);
    },
    rm: fsRm,
    writeFile: fsWriteFile,
  };

  let failure: unknown;
  try {
    await rollbackRetainedInstall({ installDirectory: install, filesystem });
  } catch (cause) {
    failure = cause;
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain("compensation was incomplete");
  expect((failure as Error).message).toContain(".rolled-back-");
  expect(await readFile(join(install, "previous.txt"), "utf8")).toBe(
    "previous install\n",
  );
  expect(await readFile(sidecar, "utf8")).toBe(
    JSON.stringify(record, null, 2) + "\n",
  );
});

async function countRegularFiles(directory: string): Promise<number> {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) count += await countRegularFiles(path);
    else if (entry.isFile()) count += 1;
  }
  return count;
}

async function createRestoredInstall(fixture: BundleFixture) {
  const install = join(fixture.root, "install");
  await mkdir(install);
  await writeFile(join(install, "previous.txt"), "previous install\n");
  const restored = await run("restore-retained-bundle.mjs", [
    "--bundle",
    fixture.bundle,
    "--install-dir",
    install,
    "--manifest-sha256",
    fixture.manifestSha256,
    "--replace",
  ]);
  if (restored.code !== 0)
    throw new Error(`Fixture restore failed: ${restored.stderr}`);
  const sidecar = `${install}.continuity-previous.json`;
  const oldSidecar = await readFile(sidecar, "utf8");
  return { install, sidecar, oldSidecar, record: JSON.parse(oldSidecar) };
}

async function createFixture(options: BundleOptions = {}) {
  const root = await createTestTempDirectory("rea-continuity-bundle-");
  const bundle = join(root, "bundle");
  await mkdir(bundle);
  const skill = await createPackageArchive(root, bundle, options);
  const sourceStage = await createSourceArchives(root, bundle);
  await createDependencyFixture(bundle, options);

  await mkdir(join(bundle, "licenses/source"), { recursive: true });
  await writeFile(join(bundle, "licenses/source/LICENSE"), "MIT fixture\n");
  await writeFile(
    join(bundle, "licenses/source/THIRD_PARTY_NOTICES.md"),
    "fixture notices\n",
  );
  await mkdir(join(bundle, "licenses/dependencies/left-pad@1.0.0"), {
    recursive: true,
  });
  await writeFile(
    join(bundle, "licenses/dependencies/left-pad@1.0.0/LICENSE"),
    "MIT\n",
  );

  const inventory = await createInventory(bundle, options.traversal === true);
  await writeFile(join(bundle, "inventory.jsonl"), inventory.text);
  const manifest = {
    schemaVersion: 1,
    kind: "rea-continuity-bundle",
    createdAt: "2026-01-04T00:00:00.000Z",
    producer: { name: "fixture", version: "1" },
    package: {
      name: "rea-agents",
      version: "1.0.0",
      tarball: "package.tgz",
      sha256: await hash(join(bundle, "package.tgz")),
    },
    vendorSkill: {
      path: "skills/reverse-engineer-anything/SKILL.md",
      version: "45",
      sha256: createHash("sha256").update(skill).digest("hex"),
    },
    source: {
      sha: SOURCE_SHA,
      branch: "main",
      clean: true,
      worktree: null,
      archive: "source.tar.gz",
      sha256: await hash(join(bundle, "source.tar.gz")),
      submodules: [
        {
          path: "third_party/wakaru",
          sha: SUBMODULE_SHA,
          archive: "submodules/third_party__wakaru.tar.gz",
          sha256: await hash(
            join(bundle, "submodules/third_party__wakaru.tar.gz"),
          ),
        },
      ],
    },
    runtime: {
      node: process.version,
      npm: "11.0.0",
      platform: options.platform ?? process.platform,
      architecture: options.architecture ?? process.arch,
    },
    compatibility: {
      node: process.version,
      engines: ">=22",
      platform: options.platform ?? process.platform,
      architecture: options.architecture ?? process.arch,
    },
    dependencies: {
      lockfileSha256: await hash(join(sourceStage, "package.json")),
      packageCount:
        options.omitDependencies === true || options.missingTransitive === true
          ? 1
          : options.scopedNestedDependency === true
            ? 3
            : 2,
      roots:
        options.omitDependencies === true
          ? []
          : [{ name: "left-pad", version: options.rootVersion ?? "1.0.0" }],
    },
    licenses: {
      notices: [
        "licenses/source/LICENSE",
        "licenses/source/THIRD_PARTY_NOTICES.md",
      ],
      dependencyNotices: 1,
    },
    inventory: {
      path: "inventory.jsonl",
      sha256: createHash("sha256").update(inventory.text).digest("hex"),
      files: inventory.count,
      bytes: inventory.bytes,
    },
  };
  await writeFile(
    join(bundle, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const manifestSha256 = await hash(join(bundle, "manifest.json"));
  if (options.corrupt === true)
    await writeFile(
      join(bundle, "dependencies/node_modules/left-pad/index.js"),
      "tampered\n",
    );
  return { root, bundle, manifestSha256 };
}

async function createPackageArchive(
  root: string,
  bundle: string,
  options: BundleOptions,
) {
  const packageStage = join(root, "package-stage");
  const packageRoot = join(packageStage, "package");
  await mkdir(join(packageRoot, "scripts"), { recursive: true });
  await mkdir(join(packageRoot, "dist/mcp"), { recursive: true });
  await mkdir(join(packageRoot, "skills/reverse-engineer-anything"), {
    recursive: true,
  });
  await writeFile(
    join(packageRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "rea-agents",
        version: "1.0.0",
        type: "module",
        dependencies: {
          "left-pad": "^1.0.0",
          ...(options.omitPackedRoot ? { "required-root": "^1.0.0" } : {}),
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(packageRoot, "scripts/rea.mjs"),
    'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\nprocess.stdout.write(JSON.stringify({ dependency: require("left-pad") }));\n',
  );
  await writeFile(join(packageRoot, "dist/mcp/main.js"), "export {};\n");
  const skill = '---\nname: fixture\nmetadata:\n  version: "45"\n---\n';
  await writeFile(
    join(packageRoot, "skills/reverse-engineer-anything/SKILL.md"),
    skill,
  );
  if (options.linkMember === "symlink")
    await symlink("scripts/rea.mjs", join(packageRoot, "linked.js"));
  if (options.linkMember === "hardlink")
    await link(
      join(packageRoot, "scripts/rea.mjs"),
      join(packageRoot, "hard.js"),
    );
  await execute("tar", [
    "-czf",
    join(bundle, "package.tgz"),
    "-C",
    packageStage,
    "package",
  ]);
  return skill;
}

async function createSourceArchives(root: string, bundle: string) {
  const sourceStage = join(root, "source-stage");
  await mkdir(sourceStage);
  await writeFile(
    join(sourceStage, "package.json"),
    `${JSON.stringify({ name: "rea-agents", version: "1.0.0", engines: { node: ">=22" } }, null, 2)}\n`,
  );
  await execute("tar", [
    "-czf",
    join(bundle, "source.tar.gz"),
    "-C",
    sourceStage,
    ".",
  ]);
  const submoduleStage = join(root, "submodule-stage");
  await mkdir(submoduleStage);
  await writeFile(join(submoduleStage, "README.md"), "pinned submodule\n");
  await mkdir(join(bundle, "submodules"));
  await execute("tar", [
    "-czf",
    join(bundle, "submodules/third_party__wakaru.tar.gz"),
    "-C",
    submoduleStage,
    ".",
  ]);
  return sourceStage;
}

async function createDependencyFixture(bundle: string, options: BundleOptions) {
  const dependencyRoot = join(bundle, "dependencies");
  await mkdir(dependencyRoot);
  if (options.omitDependencies === true) {
    await writeFile(
      join(dependencyRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "rea-continuity-dependencies",
          private: true,
          dependencies: {},
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  await writeFile(
    join(dependencyRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "rea-continuity-dependencies",
        private: true,
        dependencies: { "left-pad": "1.0.0" },
      },
      null,
      2,
    )}\n`,
  );
  const leftPad = join(dependencyRoot, "node_modules/left-pad");
  await mkdir(leftPad, { recursive: true });
  await writeFile(
    join(leftPad, "package.json"),
    `${JSON.stringify(
      {
        name: "left-pad",
        version: "1.0.0",
        main: "index.js",
        license: "MIT",
        dependencies: {
          inner: options.incompatibleTransitive ? "^2.0.0" : "1.0.0",
        },
      },
      null,
      2,
    )}\n`,
  );
  if (options.internalPackageMetadata === true) {
    const metadata = join(leftPad, "test/fixtures/transport");
    await mkdir(metadata, { recursive: true });
    await writeFile(
      join(metadata, "package.json"),
      `${JSON.stringify({ name: "transport", version: "0.0.1" })}\n`,
    );
  }
  await writeFile(join(leftPad, "index.js"), 'module.exports = "1.0.0";\n');
  if (options.missingTransitive === true) return;

  const inner = join(leftPad, "node_modules/inner");
  await mkdir(inner, { recursive: true });
  await writeFile(
    join(inner, "package.json"),
    `${JSON.stringify(
      {
        name: "inner",
        version: "1.0.0",
        main: "index.js",
        ...(options.scopedNestedDependency === true
          ? { dependencies: { "@scope/scoped": "^1.0.0" } }
          : {}),
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(inner, "index.js"), "module.exports = true;\n");
  if (options.scopedNestedDependency !== true) return;

  const scoped = join(inner, "node_modules/@scope/scoped");
  await mkdir(scoped, { recursive: true });
  await writeFile(
    join(scoped, "package.json"),
    `${JSON.stringify({ name: "@scope/scoped", version: "1.0.0" })}\n`,
  );
  await writeFile(join(scoped, "index.js"), "module.exports = true;\n");
}

async function createInventory(bundle: string, traversal: boolean) {
  const entries: { path: string; bytes: number; sha256: string }[] = [];
  const visit = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const path = absolute
        .slice(bundle.length + 1)
        .split("\\")
        .join("/");
      if (path === "inventory.jsonl" || path === "manifest.json") continue;
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      const info = await lstat(absolute);
      entries.push({ path, bytes: info.size, sha256: await hash(absolute) });
    }
  };
  await visit(bundle);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  if (traversal)
    entries.push({ path: "../escape", bytes: 0, sha256: "d".repeat(64) });
  return {
    text: `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    count: entries.length,
    bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
  };
}

async function run(script: string, args: string[]) {
  try {
    const result = await execute(process.execPath, [SCRIPT(script), ...args], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (cause) {
    const error = cause as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

async function hash(path: string) {
  const digest = createHash("sha256");
  digest.update(await readFile(path));
  return digest.digest("hex");
}
