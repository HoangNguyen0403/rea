import { execFile } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { verifyRetainedBundle } from "./bundle-verify.mjs";
import { inspectTarArchive } from "./tar-safety.mjs";

const execute = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;
const MARKER = "continuity-install.json";

/** Restore an authenticated bundle without network access. */
export async function restoreRetainedBundle({
  bundle,
  installDirectory,
  expectedManifestSha256,
  replace = false,
  now = () => new Date(),
  filesystem = { rename, rm, writeFile },
}) {
  if (
    typeof expectedManifestSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(expectedManifestSha256)
  )
    throw new Error("A trusted manifest SHA-256 is required before restore");
  const bundleRoot = resolve(bundle);
  const target = resolve(installDirectory);
  assertInstallTarget(target);
  const verified = await verifyRetainedBundle(bundleRoot, {
    expectedManifestSha256,
  });
  await mkdir(dirname(target), { recursive: true });
  const targetState = await lstatOrNull(target);
  if (targetState !== null && !targetState.isDirectory())
    throw new Error(
      "Install target must be absent or a directory, never a symlink",
    );
  const sidecar = `${target}.continuity-previous.json`;
  await assertOwnedSidecar(sidecar, target);
  if (targetState !== null && !replace)
    throw new Error(
      `Install directory already exists: ${target}; pass --replace to preserve it as a rollback candidate`,
    );
  const staging = await mkdtemp(
    join(dirname(target), `.${basename(target)}-restore-`),
  );
  const sidecarTemporary = join(
    dirname(target),
    `.${basename(target)}-sidecar-${process.pid}-${String(Date.now())}`,
  );
  const previous =
    targetState === null ? null : `${target}.previous-${timestamp(now())}`;
  if (previous !== null) await assertNoDestination(previous);
  let movedPrevious = false;
  let activated = false;
  try {
    await extractPackage(join(bundleRoot, "package.tgz"), staging);
    await cp(
      join(bundleRoot, "dependencies", "node_modules"),
      join(staging, "node_modules"),
      {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
      },
    );
    await requireInstalledFile(join(staging, "scripts", "rea.mjs"));
    await requireInstalledFile(join(staging, "dist", "mcp", "main.js"));
    await writeFile(
      join(staging, MARKER),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          kind: "rea-continuity-install",
          installedAt: now().toISOString(),
          package: verified.package,
          source: verified.source,
          runtime: verified.runtime,
          compatibility: verified.compatibility,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await filesystem.writeFile(
      sidecarTemporary,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          installDirectory: target,
          previousInstall: previous,
          installedAt: now().toISOString(),
          package: verified.package,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    if (previous !== null) {
      await filesystem.rename(target, previous);
      movedPrevious = true;
    }
    await filesystem.rename(staging, target);
    activated = true;
    await filesystem.rename(sidecarTemporary, sidecar);
    return {
      state: "restored",
      installDirectory: target,
      previousInstall: previous,
      package: verified.package,
      source: verified.source,
      runtime: verified.runtime,
    };
  } catch (cause) {
    const failed = `${target}.failed-${timestamp(now())}`;
    const compensationFailures = [];
    let failedInstallPreserved = false;
    if (activated) {
      try {
        await filesystem.rename(target, failed);
        failedInstallPreserved = true;
      } catch (compensationError) {
        compensationFailures.push(compensationError);
      }
    }
    if (movedPrevious && (!activated || failedInstallPreserved)) {
      try {
        await filesystem.rename(previous, target);
        movedPrevious = false;
      } catch (compensationError) {
        compensationFailures.push(compensationError);
      }
    }
    if (compensationFailures.length === 0) {
      for (const path of [
        failedInstallPreserved ? failed : null,
        staging,
        sidecarTemporary,
      ]) {
        if (path === null) continue;
        try {
          await filesystem.rm(path, { recursive: true, force: true });
        } catch (cleanupError) {
          compensationFailures.push(cleanupError);
        }
      }
    }
    if (compensationFailures.length > 0) {
      const recoveryPaths = [
        target,
        movedPrevious ? previous : null,
        activated && !failedInstallPreserved ? target : null,
        failedInstallPreserved ? failed : null,
        staging,
        sidecarTemporary,
      ].filter((path) => path !== null);
      throw new Error(
        `Continuity restore failed and compensation was incomplete; inspect recovery paths: ${recoveryPaths.join(", ")}; ${compensationFailures.map((error) => String(error?.message ?? error)).join("; ")}`,
        { cause },
      );
    }
    throw cause;
  }
}

/** Swap back the exact prior install recorded by a successful restore. */
export async function rollbackRetainedInstall({
  installDirectory,
  now = () => new Date(),
  filesystem = { rename, rm, writeFile },
}) {
  const target = resolve(installDirectory);
  const sidecar = `${target}.continuity-previous.json`;
  const record = await readOwnedSidecar(sidecar, target);
  if (
    typeof record.previousInstall !== "string" ||
    !(await exists(record.previousInstall))
  )
    throw new Error(
      "Continuity rollback record has no preserved previous install",
    );
  await readFile(join(target, MARKER), "utf8");
  const rolledBack = `${target}.rolled-back-${timestamp(now())}`;
  await assertNoDestination(rolledBack);
  const sidecarTemporary = `${sidecar}.tmp-${String(process.pid)}-${String(Date.now())}`;
  let currentInstallMoved = false;
  let previousInstallActivated = false;
  try {
    await filesystem.writeFile(
      sidecarTemporary,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          installDirectory: target,
          previousInstall: rolledBack,
          restoredFrom: record.previousInstall,
          rolledBackAt: now().toISOString(),
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await filesystem.rename(target, rolledBack);
    currentInstallMoved = true;
    await filesystem.rename(record.previousInstall, target);
    previousInstallActivated = true;
    await filesystem.rename(sidecarTemporary, sidecar);
    return {
      state: "rolled-back",
      installDirectory: target,
      previousInstall: rolledBack,
    };
  } catch (cause) {
    const compensationFailures = [];
    if (previousInstallActivated) {
      try {
        await filesystem.rename(target, record.previousInstall);
        previousInstallActivated = false;
      } catch (compensationError) {
        compensationFailures.push(compensationError);
      }
    }
    if (currentInstallMoved && !previousInstallActivated) {
      try {
        await filesystem.rename(rolledBack, target);
        currentInstallMoved = false;
      } catch (compensationError) {
        compensationFailures.push(compensationError);
      }
    }
    if (compensationFailures.length === 0) {
      try {
        await filesystem.rm(sidecarTemporary, { force: true });
      } catch (cleanupError) {
        compensationFailures.push(cleanupError);
      }
    }
    if (compensationFailures.length > 0) {
      const recoveryPaths = [
        target,
        currentInstallMoved ? rolledBack : null,
        previousInstallActivated ? record.previousInstall : null,
        sidecarTemporary,
        sidecar,
      ].filter((path) => path !== null);
      throw new Error(
        `Continuity rollback failed and compensation was incomplete; inspect recovery paths: ${recoveryPaths.join(", ")}; ${compensationFailures.map((error) => String(error?.message ?? error)).join("; ")}`,
        { cause },
      );
    }
    throw cause;
  }
}

async function extractPackage(tarball, destination) {
  const listing = await inspectTarArchive(tarball);
  for (const member of listing)
    if (!member.startsWith("package/"))
      throw new Error(
        `Retained package archive member is outside package/: ${member}`,
      );
  await execute(
    "tar",
    ["-xzf", tarball, "--strip-components=1", "-C", destination],
    {
      maxBuffer: MAX_BUFFER,
    },
  );
}

async function requireInstalledFile(path) {
  const info = await lstat(path);
  if (!info.isFile()) throw new Error(`Restored install is missing ${path}`);
}

function assertInstallTarget(target) {
  if (target === "/" || dirname(target) === target)
    throw new Error("Install directory must not be a filesystem root");
}

async function assertOwnedSidecar(sidecar, target) {
  const info = await lstatOrNull(sidecar);
  if (info === null) return;
  if (!info.isFile())
    throw new Error("Existing continuity sidecar is not a regular file");
  await readOwnedSidecar(sidecar, target);
}

async function readOwnedSidecar(sidecar, target) {
  const info = await lstat(sidecar);
  if (!info.isFile())
    throw new Error("Continuity sidecar is not a regular file");
  let record;
  try {
    record = JSON.parse(await readFile(sidecar, "utf8"));
  } catch (cause) {
    throw new Error("Continuity sidecar is malformed", { cause });
  }
  if (
    typeof record !== "object" ||
    record === null ||
    record.schemaVersion !== 1 ||
    record.installDirectory !== target
  )
    throw new Error("Continuity sidecar does not belong to this install");
  return record;
}

async function assertNoDestination(path) {
  if (await exists(path))
    throw new Error(`Preserved install destination already exists: ${path}`);
}

async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch (cause) {
    if (cause?.code === "ENOENT") return null;
    throw cause;
  }
}

async function exists(path) {
  return (await lstatOrNull(path)) !== null;
}

function timestamp(date) {
  return date.toISOString().replaceAll(/[:.]/gu, "-");
}
