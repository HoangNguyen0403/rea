import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { reportFailure, requireValue, UsageError } from "./lib/cli.mjs";
import { restoreRetainedBundle } from "./lib/restore.mjs";

const USAGE =
  "Usage: node scripts/continuity/restore-retained-bundle.mjs --bundle DIR --install-dir DIR --manifest-sha256 SHA256 [--replace] [--json]";

try {
  const { values } = parseArgs({
    options: {
      bundle: { type: "string" },
      "install-dir": { type: "string" },
      "manifest-sha256": { type: "string" },
      replace: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
  } else {
    const bundle = requireValue(values.bundle, "--bundle");
    const installDirectory = requireValue(
      values["install-dir"],
      "--install-dir",
    );
    if (
      typeof values["manifest-sha256"] !== "string" ||
      !/^[a-f0-9]{64}$/u.test(values["manifest-sha256"])
    )
      throw new UsageError(
        "--manifest-sha256 must be a 64-character lowercase SHA-256",
      );
    const result = await restoreRetainedBundle({
      bundle: resolve(bundle),
      installDirectory,
      expectedManifestSha256: values["manifest-sha256"],
      replace: values.replace,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
} catch (cause) {
  reportFailure(cause, USAGE);
}
