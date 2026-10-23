import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, writeFile } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";

export const MANIFEST_NAME = "manifest.json";
export const INVENTORY_NAME = "inventory.jsonl";

/** Reject absolute, traversal, separator, and control-character paths. */
export function assertSafeBundlePath(path) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /[\u0000-\u001f\u007f]/u.test(path)
  )
    throw new Error(`Unsafe bundle path: ${JSON.stringify(path)}`);
  const segments = path.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  )
    throw new Error(`Unsafe bundle path: ${JSON.stringify(path)}`);
  return path;
}

/** Hash a file without reading it wholly into memory. */
export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Walk regular files only; a symlink would escape bundle verification. */
export async function walkBundleFiles(root, { exclude = [] } = {}) {
  const excluded = new Set(exclude);
  const files = [];
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(
          `Bundle contains a symbolic link: ${relative(root, absolute)}`,
        );
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile())
        throw new Error(
          `Bundle contains a non-regular entry: ${relative(root, absolute)}`,
        );
      const path = relative(root, absolute).split(sep).join(posix.sep);
      assertSafeBundlePath(path);
      if (!excluded.has(path)) files.push({ path, absolute });
    }
  };
  await visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

/** Produce the only inventory representation used by manifests and restores. */
export async function writeBundleInventory(root, { exclude = [] } = {}) {
  const files = await walkBundleFiles(root, { exclude });
  const entries = [];
  for (const file of files) {
    const info = await lstat(file.absolute);
    entries.push({
      path: file.path,
      bytes: info.size,
      sha256: await sha256File(file.absolute),
    });
  }
  const text = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}${entries.length === 0 ? "" : "\n"}`;
  const path = join(root, INVENTORY_NAME);
  await writeFile(path, text, "utf8");
  return {
    path: INVENTORY_NAME,
    sha256: await sha256File(path),
    files: entries.length,
    bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
  };
}

/** Parse inventory lines without accepting extra fields or duplicate paths. */
export function parseBundleInventory(text) {
  const entries = [];
  const paths = new Set();
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch (cause) {
      throw new Error("Bundle inventory contains malformed JSON", { cause });
    }
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "bytes,path,sha256"
    )
      throw new Error("Bundle inventory entry has missing or unknown fields");
    assertSafeBundlePath(value.path);
    if (
      !Number.isSafeInteger(value.bytes) ||
      value.bytes < 0 ||
      typeof value.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.sha256)
    )
      throw new Error(
        `Bundle inventory entry has invalid metadata: ${value.path}`,
      );
    if (paths.has(value.path))
      throw new Error(`Bundle inventory repeats a path: ${value.path}`);
    paths.add(value.path);
    entries.push(value);
  }
  return entries;
}
