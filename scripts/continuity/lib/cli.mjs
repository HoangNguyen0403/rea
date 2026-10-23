/** Distinguish caller mistakes from verification or operational failures. */
export class UsageError extends Error {
  name = "UsageError";
}

export function requireValue(value, flag) {
  if (typeof value !== "string" || value.length === 0)
    throw new UsageError(`${flag} is required`);
  return value;
}

export function reportFailure(cause, usage) {
  process.stderr.write(
    `${cause instanceof Error ? cause.message : String(cause)}\n${usage}\n`,
  );
  process.exitCode =
    cause instanceof UsageError ||
    (typeof cause?.code === "string" && cause.code.startsWith("ERR_PARSE_ARGS"))
      ? 2
      : 1;
}
