import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);
const ROOT = join(import.meta.dirname, "../../..");

it("does not pass ambient credentials into the synthetic analysis process", async () => {
  const root = await createTestTempDirectory("rea-continuity-smoke-");
  const install = join(root, "install");
  await mkdir(join(install, "scripts"), { recursive: true });
  await writeFile(
    join(install, "continuity-install.json"),
    `${JSON.stringify({ kind: "rea-continuity-install", package: { version: "fixture" } })}\n`,
  );
  await writeFile(
    join(install, "scripts/rea.mjs"),
    [
      "if (process.env.REA_SMOKE_SENTINEL !== undefined) {",
      '  process.stderr.write("ambient credential reached the analysis process\\n");',
      "  process.exit(1);",
      "}",
      "process.stdout.write(JSON.stringify({",
      '  operation: "analyze_javascript_application",',
      '  provider: { id: "rea-javascript-application" },',
      '  normalized_result: { format: "directory" },',
      "}));",
      "",
    ].join("\n"),
  );

  const result = await execute(
    process.execPath,
    [
      join(ROOT, "scripts/continuity/smoke-static-js.mjs"),
      "--install-dir",
      install,
    ],
    {
      cwd: ROOT,
      env: { ...process.env, REA_SMOKE_SENTINEL: "must-not-leak" },
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );

  expect(JSON.parse(result.stdout)).toMatchObject({ state: "smoke-passed" });
});
