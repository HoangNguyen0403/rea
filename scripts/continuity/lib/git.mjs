import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const MAX_BUFFER = 32 * 1024 * 1024;

/** Run Git without prompting and retain the exact exit status for decisions. */
export async function gitResult(
  cwd,
  args,
  { env = {}, timeout = 120_000 } = {},
) {
  try {
    const { stdout, stderr } = await execute("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
      timeout,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
        ...env,
      },
    });
    return { ok: true, code: 0, stdout, stderr };
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      typeof cause.code === "number"
    )
      return {
        ok: false,
        code: cause.code,
        stdout: typeof cause.stdout === "string" ? cause.stdout : "",
        stderr: typeof cause.stderr === "string" ? cause.stderr : "",
      };
    throw cause;
  }
}

/** Run a Git command whose failure invalidates the caller's operation. */
export async function git(cwd, args, options) {
  const result = await gitResult(cwd, args, options);
  if (!result.ok)
    throw new Error(
      `git ${args.join(" ")} failed (${String(result.code)}): ${sanitizeOutput(result.stderr, result.stdout)}`,
    );
  return result.stdout.trim();
}

/** Run a read-only probe and represent a missing ref or path as null. */
export async function gitMaybe(cwd, args, options) {
  const result = await gitResult(cwd, args, options);
  return result.ok ? result.stdout.trim() : null;
}

/** Require a full object name so ref names never become manifest identity. */
export async function resolveCommit(cwd, ref) {
  const sha = await gitMaybe(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
  if (sha === null || !/^[a-f0-9]{40}$/u.test(sha))
    throw new Error(`Could not resolve ${ref} to a full commit SHA`);
  return sha;
}

/** Keep command diagnostics free of URLs, credentials, and duplicated output. */
export function sanitizeOutput(stderr, stdout) {
  const text = `${stderr}\n${stdout}`.replaceAll(/\s+/gu, " ").trim();
  return text.length > 800 ? `${text.slice(0, 800)}...` : text || "no output";
}
