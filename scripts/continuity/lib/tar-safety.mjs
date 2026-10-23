import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { parseTarListing } from "../../lib/verify-package-listing.mjs";

const execute = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

/** Require every archive member to be a plain file or directory with a safe name. */
export async function inspectTarArchive(tarball) {
  const environment = { ...process.env, LC_ALL: "C" };
  const names = parseTarListing(
    (
      await execute("tar", ["-tzf", tarball], {
        maxBuffer: MAX_BUFFER,
        env: environment,
      })
    ).stdout,
  );
  const verbose = parseTarListing(
    (
      await execute("tar", ["-tvzf", tarball], {
        maxBuffer: MAX_BUFFER,
        env: environment,
      })
    ).stdout,
  );
  if (names.length === 0) throw new Error("Retained archive is empty");
  if (names.length !== verbose.length)
    throw new Error("Retained archive listing is ambiguous");
  const seen = new Set();
  for (const [index, member] of names.entries()) {
    const type = verbose[index]?.[0];
    if (type !== "-" && type !== "d")
      throw new Error(
        `Retained archive member ${JSON.stringify(member)} is not a regular file or directory`,
      );
    const segments = member.split("/");
    if (
      member.startsWith("/") ||
      member.includes("\\") ||
      segments.some((segment) => segment === "." || segment === "..")
    )
      throw new Error(`Retained archive contains an unsafe member: ${member}`);
    if (seen.has(member))
      throw new Error(`Retained archive repeats member ${member}`);
    seen.add(member);
  }
  return names;
}
