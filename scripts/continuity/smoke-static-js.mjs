import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";

import { reportFailure, UsageError } from "./lib/cli.mjs";

const execute = promisify(execFile);
const USAGE =
  "Usage: node scripts/continuity/smoke-static-js.mjs --install-dir DIR [--json]";

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
    const result = await smoke(resolve(values["install-dir"]));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
} catch (cause) {
  reportFailure(cause, USAGE);
}

/** Exercise only synthetic static JavaScript against the restored install. */
async function smoke(installDirectory) {
  const marker = JSON.parse(
    await readFile(join(installDirectory, "continuity-install.json"), "utf8"),
  );
  if (marker?.kind !== "rea-continuity-install")
    throw new Error("Install directory is not an owned continuity install");
  const workspace = await mkdtemp(join(tmpdir(), "rea-continuity-smoke-"));
  try {
    const home = join(workspace, "home");
    await mkdir(home);
    const fixture = join(workspace, "synthetic-javascript");
    await mkdir(fixture);
    await writeFile(
      join(fixture, "package.json"),
      `${JSON.stringify({ name: "synthetic-continuity-fixture", version: "1.0.0", main: "main.js" }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(fixture, "main.js"),
      [
        'const { readFileSync } = require("node:fs");',
        "",
        "function loadConfig(path) {",
        '  return readFileSync(path, "utf8").trim();',
        "}",
        "",
        "module.exports = { loadConfig };",
        "",
      ].join("\n"),
      "utf8",
    );
    const environment = {
      PATH:
        process.platform === "win32"
          ? "C:\\Windows\\System32;C:\\Windows"
          : "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: home,
      USERPROFILE: home,
      TMPDIR: workspace,
      TEMP: workspace,
      TMP: workspace,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      NO_COLOR: "1",
      REA_ANALYSIS_PROVIDER: "auto",
    };
    const { stdout } = await execute(
      process.execPath,
      [
        join(installDirectory, "scripts", "rea.mjs"),
        "analyze-javascript-application",
        fixture,
        "--json",
      ],
      {
        cwd: workspace,
        env: environment,
        timeout: 120_000,
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    const result = JSON.parse(stdout);
    if (
      result?.operation !== "analyze_javascript_application" ||
      result?.provider?.id !== "rea-javascript-application" ||
      result?.normalized_result?.format !== "directory"
    )
      throw new Error(
        "Restored install did not complete static JavaScript analysis",
      );
    return {
      state: "smoke-passed",
      installDirectory,
      package: marker.package,
      operation: result.operation,
      provider: result.provider.id,
      format: result.normalized_result.format,
      syntheticInput: true,
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
