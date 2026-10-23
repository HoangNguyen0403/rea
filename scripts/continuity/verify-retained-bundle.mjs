import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { verifyRetainedBundle } from "./lib/bundle-verify.mjs";
import { reportFailure, UsageError } from "./lib/cli.mjs";

const USAGE =
  "Usage: node scripts/continuity/verify-retained-bundle.mjs DIR --manifest-sha256 SHA256 [--allow-foreign-platform] [--json]";

try {
  const { values, positionals } = parseArgs({
    options: {
      "manifest-sha256": { type: "string" },
      "allow-foreign-platform": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
  } else {
    const root = positionals[0];
    if (root === undefined || positionals.length !== 1)
      throw new UsageError("Exactly one bundle directory is required");
    if (
      typeof values["manifest-sha256"] !== "string" ||
      !/^[a-f0-9]{64}$/u.test(values["manifest-sha256"])
    )
      throw new UsageError(
        "--manifest-sha256 must be a 64-character lowercase SHA-256",
      );
    const result = await verifyRetainedBundle(resolve(root), {
      expectedManifestSha256: values["manifest-sha256"],
      allowForeignPlatform: values["allow-foreign-platform"],
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
} catch (cause) {
  reportFailure(cause, USAGE);
}
