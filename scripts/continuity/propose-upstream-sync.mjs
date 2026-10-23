import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { reportFailure, requireValue } from "./lib/cli.mjs";
import { createGitHubApi } from "./lib/github.mjs";
import { proposeUpstreamSync } from "./lib/sync.mjs";

const USAGE =
  "Usage: node scripts/continuity/propose-upstream-sync.mjs --repository OWNER/REPO --upstream-url URL [--upstream-branch main] [--base-branch main] [--dry-run] [--json]";

try {
  const { values } = parseArgs({
    options: {
      repository: { type: "string" },
      "upstream-url": { type: "string" },
      "upstream-branch": { type: "string", default: "main" },
      "base-branch": { type: "string", default: "main" },
      "dry-run": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exitCode = 0;
  } else {
    const repository = requireValue(values.repository, "--repository");
    const upstreamUrl = requireValue(values["upstream-url"], "--upstream-url");
    const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
    const api =
      token === undefined
        ? {
            listOpenPullRequests: async () => [],
            createPullRequest: async () => {
              throw new Error(
                "A GitHub token is required to create a proposal",
              );
            },
          }
        : createGitHubApi({ repository, token });
    if (!values["dry-run"] && token === undefined)
      throw new Error("GH_TOKEN or GITHUB_TOKEN is required");
    const result = await proposeUpstreamSync({
      cwd: resolve(process.cwd()),
      upstreamUrl,
      upstreamBranch: values["upstream-branch"],
      baseBranch: values["base-branch"],
      api,
      dryRun: values["dry-run"],
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
} catch (cause) {
  reportFailure(cause, USAGE);
}
