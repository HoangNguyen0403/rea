import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { reportFailure, UsageError } from "./lib/cli.mjs";
import { rollbackRetainedInstall } from "./lib/restore.mjs";

const USAGE =
  "Usage: node scripts/continuity/rollback-retained-install.mjs --install-dir DIR [--json]";

try {
  const { values } = parseArgs({
    options: {
      "install-dir": { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
  } else {
    if (
      typeof values["install-dir"] !== "string" ||
      values["install-dir"].length === 0
    )
      throw new UsageError("--install-dir is required");
    const result = await rollbackRetainedInstall({
      installDirectory: resolve(values["install-dir"]),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
} catch (cause) {
  reportFailure(cause, USAGE);
}
