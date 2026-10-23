import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);
const ROOT = join(import.meta.dirname, "../../..");
const SYNC_SCRIPT = join(ROOT, "scripts/continuity/propose-upstream-sync.mjs");

it("reports a current base without touching Git or GitHub", async () => {
  const fixture = await createFixture({ advanceUpstream: false });
  const github = await fakeGitHub();

  try {
    const result = await runSync(
      fixture.work,
      fixture.upstream,
      github.environment,
    );

    expect(result.state).toBe("current");
    expect(github.requests).toHaveLength(0);
  } finally {
    await github.close();
  }
});

it("proposes one reviewed merge and is idempotent for the same revision", async () => {
  const fixture = await createFixture();
  const github = await fakeGitHub();

  try {
    const first = await runSync(
      fixture.work,
      fixture.upstream,
      github.environment,
    );
    await git(fixture.work, ["fetch", "origin"]);
    const mainBefore = await git(fixture.work, ["rev-parse", "origin/main"]);
    const branchBefore = await git(fixture.work, [
      "rev-parse",
      `origin/${first.branch}`,
    ]);

    expect(first).toMatchObject({ state: "proposed", conflicts: [] });
    expect(github.creations).toHaveLength(1);
    expect(github.creations[0]).toMatchObject({
      draft: true,
      base: { ref: "main" },
      head: { ref: first.branch },
    });
    expect(await readFile(join(fixture.work, "local.txt"), "utf8")).toBe(
      "local patch\n",
    );
    expect(await git(fixture.work, ["rev-parse", "origin/main"])).toBe(
      mainBefore,
    );
    const record = JSON.parse(
      await git(fixture.work, [
        "show",
        `origin/${first.branch}:.github/continuity/upstream-sync/${first.upstreamSha}.json`,
      ]),
    );
    expect(record).toMatchObject({
      kind: "rea-upstream-sync",
      upstream: { sha: first.upstreamSha },
    });

    const second = await runSync(
      fixture.work,
      fixture.upstream,
      github.environment,
    );
    expect(second.state).toBe("already-proposed");
    expect(github.creations).toHaveLength(1);
    expect(
      await git(fixture.work, ["rev-parse", `origin/${first.branch}`]),
    ).toBe(branchBefore);
  } finally {
    await github.close();
  }
});

it("preserves main and local patches when upstream conflicts", async () => {
  const fixture = await createFixture({ conflict: true });
  const github = await fakeGitHub();

  try {
    const mainBefore = await git(fixture.work, ["rev-parse", "origin/main"]);
    const result = await runSync(
      fixture.work,
      fixture.upstream,
      github.environment,
    );
    await git(fixture.work, ["fetch", "origin"]);

    expect(result.state).toBe("conflict-proposed");
    expect(result.conflicts).toContain("shared.txt");
    expect(await readFile(join(fixture.work, "shared.txt"), "utf8")).toBe(
      "local\n",
    );
    expect(await git(fixture.work, ["rev-parse", "origin/main"])).toBe(
      mainBefore,
    );
    const record = JSON.parse(
      await git(fixture.work, [
        "show",
        `origin/${result.branch}:.github/continuity/upstream-conflicts/${result.upstreamSha}.json`,
      ]),
    );
    expect(record).toMatchObject({
      kind: "rea-upstream-sync-conflict",
      mergeBasePreserved: true,
      conflictPaths: ["shared.txt"],
    });
    expect(github.creations[0]?.body).toContain("Conflicts preserved");
    expect(github.creations[0]?.body).toContain("git merge");
  } finally {
    await github.close();
  }
});

it("keeps dry-run read-only when a remote proposal branch already exists", async () => {
  const fixture = await createFixture();
  const firstServer = await fakeGitHub();
  const first = await runSync(
    fixture.work,
    fixture.upstream,
    firstServer.environment,
  );
  await git(fixture.work, ["fetch", "origin"]);
  const branchBefore = await git(fixture.work, [
    "rev-parse",
    `origin/${first.branch}`,
  ]);
  await firstServer.close();
  const secondServer = await fakeGitHub();

  try {
    const result = await runSync(
      fixture.work,
      fixture.upstream,
      secondServer.environment,
      ["--dry-run"],
    );

    expect(result).toMatchObject({ state: "dry-run", existingBranch: true });
    expect(secondServer.creations).toHaveLength(0);
    await git(fixture.work, ["fetch", "origin"]);
    expect(
      await git(fixture.work, ["rev-parse", `origin/${first.branch}`]),
    ).toBe(branchBefore);
  } finally {
    await secondServer.close();
  }
});

it("does not delete a pre-existing local continuity branch", async () => {
  const fixture = await createFixture();
  const github = await fakeGitHub();
  const shortSha = (
    await git(fixture.work, ["ls-remote", fixture.upstream, "refs/heads/main"])
  ).slice(0, 12);
  const localBranch = `continuity/upstream-${shortSha}`;
  await git(fixture.work, ["branch", localBranch]);
  const before = await git(fixture.work, ["rev-parse", localBranch]);

  try {
    await runSync(fixture.work, fixture.upstream, github.environment);
    expect(await git(fixture.work, ["rev-parse", localBranch])).toBe(before);
  } finally {
    await github.close();
  }
});

it("skips a different pending sync proposal instead of creating duplicates", async () => {
  const fixture = await createFixture();
  const github = await fakeGitHub([
    {
      number: 7,
      html_url: "https://example.invalid/pull/7",
      head: { ref: "continuity/upstream-deadbeef0000" },
    },
  ]);

  try {
    const result = await runSync(
      fixture.work,
      fixture.upstream,
      github.environment,
    );

    expect(result.state).toBe("pending-review");
    expect(result.pending).toHaveLength(1);
    expect(github.creations).toHaveLength(0);
  } finally {
    await github.close();
  }
});

it("inspects mergeability without pushing or creating a proposal", async () => {
  const fixture = await createFixture();
  const github = await fakeGitHub();

  try {
    const result = await runSync(
      fixture.work,
      fixture.upstream,
      github.environment,
      ["--dry-run"],
    );

    expect(result).toMatchObject({
      state: "dry-run",
      mergeable: true,
      conflicts: [],
    });
    expect(github.creations).toHaveLength(0);
    await expect(
      git(fixture.work, ["rev-parse", "--verify", `origin/${result.branch}`]),
    ).rejects.toThrow();
  } finally {
    await github.close();
  }
});

async function createFixture({
  advanceUpstream = true,
  conflict = false,
}: { advanceUpstream?: boolean; conflict?: boolean } = {}) {
  const root = await createTestTempDirectory("rea-continuity-sync-");
  const upstream = join(root, "upstream.git");
  const origin = join(root, "origin.git");
  await execute("git", ["init", "--bare", "--initial-branch=main", upstream]);
  await execute("git", ["init", "--bare", "--initial-branch=main", origin]);
  const seed = join(root, "seed");
  await execute("git", ["clone", upstream, seed]);
  await writeFile(join(seed, "shared.txt"), "base\n");
  await writeFile(join(seed, "base.txt"), "base\n");
  await git(seed, ["add", "."]);
  await git(seed, ["commit", "-m", "base"]);
  await git(seed, ["push", "origin", "main"]);

  const work = join(root, "work");
  await execute("git", ["clone", upstream, work]);
  await git(work, ["remote", "set-url", "origin", origin]);
  await git(work, ["push", "-u", "origin", "main"]);
  if (conflict) await writeFile(join(work, "shared.txt"), "local\n");
  else await writeFile(join(work, "local.txt"), "local patch\n");
  await git(work, ["add", "."]);
  await git(work, ["commit", "-m", "local patch"]);
  await git(work, ["push", "origin", "main"]);

  if (advanceUpstream) {
    const upstreamWork = join(root, "upstream-work");
    await execute("git", ["clone", upstream, upstreamWork]);
    if (conflict)
      await writeFile(join(upstreamWork, "shared.txt"), "upstream\n");
    else
      await writeFile(join(upstreamWork, "upstream.txt"), "upstream change\n");
    await git(upstreamWork, ["add", "."]);
    await git(upstreamWork, ["commit", "-m", "upstream change"]);
    await git(upstreamWork, ["push", "origin", "main"]);
  }
  return { root, upstream, origin, work };
}

async function fakeGitHub(initialPulls: Record<string, unknown>[] = []) {
  const pulls = [...initialPulls];
  const creations: Record<string, unknown>[] = [];
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    requests.push(`${request.method ?? "GET"} ${request.url ?? ""}`);
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(pulls));
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const created = {
      ...JSON.parse(body),
      number: pulls.length + 1,
      html_url: `https://example.invalid/pull/${String(pulls.length + 1)}`,
      head: { ref: JSON.parse(body).head },
      base: { ref: JSON.parse(body).base },
    };
    creations.push(created);
    pulls.push(created);
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify(created));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Fake GitHub server did not bind a port");
  return {
    requests,
    creations,
    environment: {
      REA_CONTINUITY_GITHUB_API_URL: `http://127.0.0.1:${String(address.port)}`,
      GH_TOKEN: "fixture-token",
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function runSync(
  work: string,
  upstream: string,
  environment: Record<string, string>,
  extra: string[] = [],
) {
  const result = await execute(
    process.execPath,
    [
      SYNC_SCRIPT,
      "--repository",
      "fixture/rea",
      "--upstream-url",
      upstream,
      ...extra,
    ],
    {
      cwd: work,
      env: { ...process.env, ...environment },
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  return JSON.parse(result.stdout);
}

async function git(directory: string, args: string[]) {
  const result = await execute(
    "git",
    [
      "-c",
      "user.name=REA fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { cwd: directory, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  return result.stdout.trim();
}
