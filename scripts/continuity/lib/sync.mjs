import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdtemp,
  mkdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  git,
  gitMaybe,
  gitResult,
  resolveCommit,
  sanitizeOutput,
} from "./git.mjs";

export const SYNC_BRANCH_PREFIX = "continuity/upstream-";
const UPSTREAM_REMOTE_REF = "refs/remotes/rea-continuity/upstream";
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const SAFE_URL = /^(?:https:\/\/|ssh:\/\/|git@|file:\/\/|\/)/u;

/** Derive the only branch name allowed to represent one upstream revision. */
export const syncBranchFor = (upstreamSha) =>
  `${SYNC_BRANCH_PREFIX}${upstreamSha.slice(0, 12)}`;

/** Propose a reviewed upstream merge without touching the local base branch. */
export async function proposeUpstreamSync({
  cwd,
  upstreamUrl,
  upstreamBranch = "main",
  baseBranch = "main",
  api,
  dryRun = false,
  now = () => new Date(),
}) {
  validateInputs({ upstreamUrl, upstreamBranch, baseBranch });
  if (
    (await git(cwd, ["status", "--porcelain", "--untracked-files=normal"])) !==
    ""
  )
    throw new Error("The sync proposal requires a clean Git worktree");

  const baseSha = await resolveBase(cwd, baseBranch);
  await git(cwd, [
    "fetch",
    "--no-tags",
    "--prune",
    "--",
    upstreamUrl,
    `+refs/heads/${upstreamBranch}:${UPSTREAM_REMOTE_REF}`,
  ]);
  const upstreamSha = await resolveCommit(cwd, UPSTREAM_REMOTE_REF);
  const ancestor = await gitResult(cwd, [
    "merge-base",
    "--is-ancestor",
    upstreamSha,
    baseSha,
  ]);
  if (ancestor.ok)
    return { state: "current", upstreamSha, baseSha, branch: null };

  const branch = syncBranchFor(upstreamSha);
  const pulls = await api.listOpenPullRequests(baseBranch);
  const syncPulls = pulls.filter(
    (pull) =>
      typeof pull?.head?.ref === "string" &&
      pull.head.ref.startsWith(SYNC_BRANCH_PREFIX),
  );
  const identical = syncPulls.find((pull) => pull.head.ref === branch);
  if (identical !== undefined)
    return {
      state: "already-proposed",
      upstreamSha,
      baseSha,
      branch,
      pullRequest: { number: identical.number, url: identical.html_url },
    };
  if (syncPulls.length > 0)
    return {
      state: "pending-review",
      upstreamSha,
      baseSha,
      branch,
      pending: syncPulls.map((pull) => ({
        number: pull.number,
        url: pull.html_url,
        head: pull.head.ref,
      })),
    };

  const remoteBranch = await gitMaybe(cwd, [
    "ls-remote",
    "--heads",
    "origin",
    `refs/heads/${branch}`,
  ]);
  if (remoteBranch !== null && remoteBranch.length > 0)
    return await proposeExistingBranch({
      cwd,
      api,
      branch,
      baseBranch,
      baseSha,
      dryRun,
      upstream: { url: upstreamUrl, ref: upstreamBranch, sha: upstreamSha },
    });

  const worktree = await mkdtemp(join(tmpdir(), "rea-continuity-sync-"));
  const localBranch = `continuity-work-${upstreamSha.slice(0, 12)}-${randomUUID().slice(0, 8)}`;
  let createdLocalBranch = false;
  try {
    await git(cwd, ["worktree", "add", "--detach", worktree, baseSha]);
    await git(worktree, ["switch", "-c", localBranch]);
    createdLocalBranch = true;
    await configureCommitter(worktree);
    const merge = await gitResult(worktree, [
      "merge",
      "--no-commit",
      "--no-ff",
      upstreamSha,
    ]);
    const createdAt = now().toISOString();
    if (merge.ok) {
      const changedFiles = (
        await git(worktree, ["diff", "--cached", "--name-only"])
      )
        .split("\n")
        .filter(Boolean);
      await writeSyncRecord(worktree, upstreamSha, {
        schemaVersion: 1,
        kind: "rea-upstream-sync",
        createdAt,
        upstream: { url: upstreamUrl, ref: upstreamBranch, sha: upstreamSha },
        base: { branch: baseBranch, sha: baseSha },
        changedFiles,
      });
      await git(worktree, ["add", "-A"]);
      await git(worktree, [
        "commit",
        "--no-verify",
        "-m",
        `chore(continuity): sync upstream ${upstreamSha.slice(0, 12)}`,
      ]);
      if (dryRun)
        return {
          state: "dry-run",
          mergeable: true,
          conflicts: [],
          upstreamSha,
          baseSha,
          branch,
          changedFiles,
        };
      await pushBranch(worktree, branch);
      const pull = await createPull({
        api,
        branch,
        baseBranch,
        title: `chore(continuity): sync upstream ${upstreamSha.slice(0, 12)}`,
        conflicts: [],
        upstreamSha,
        baseSha,
        upstreamUrl,
        changedFiles,
      });
      return {
        state: "proposed",
        upstreamSha,
        baseSha,
        branch,
        conflicts: [],
        changedFiles,
        pullRequest: { number: pull.number, url: pull.html_url },
      };
    }

    const conflictPaths = (
      await git(worktree, ["diff", "--name-only", "--diff-filter=U"])
    )
      .split("\n")
      .filter(Boolean);
    await git(worktree, ["merge", "--abort"]);
    const record = {
      schemaVersion: 1,
      kind: "rea-upstream-sync-conflict",
      createdAt,
      upstream: { url: upstreamUrl, ref: upstreamBranch, sha: upstreamSha },
      base: { branch: baseBranch, sha: baseSha },
      conflictPaths,
      mergeBasePreserved: true,
      guidance:
        "Resolve this branch locally without force-pushing. The base branch and local patches were not modified.",
    };
    if (dryRun)
      return {
        state: "dry-run",
        mergeable: false,
        conflicts: conflictPaths,
        upstreamSha,
        baseSha,
        branch,
      };
    await writeConflictRecord(worktree, upstreamSha, record);
    await git(worktree, ["add", "-A"]);
    await git(worktree, [
      "commit",
      "--no-verify",
      "-m",
      `chore(continuity): report upstream conflict ${upstreamSha.slice(0, 12)}`,
    ]);
    await pushBranch(worktree, branch);
    const pull = await createPull({
      api,
      branch,
      baseBranch,
      title: `chore(continuity): resolve upstream conflict ${upstreamSha.slice(0, 12)}`,
      conflicts: conflictPaths,
      upstreamSha,
      baseSha,
      upstreamUrl,
      changedFiles: [],
    });
    return {
      state: "conflict-proposed",
      upstreamSha,
      baseSha,
      branch,
      conflicts: conflictPaths,
      pullRequest: { number: pull.number, url: pull.html_url },
    };
  } finally {
    await gitResult(cwd, ["worktree", "remove", "--force", worktree]);
    await rm(worktree, { recursive: true, force: true });
    if (createdLocalBranch) await gitResult(cwd, ["branch", "-D", localBranch]);
  }
}

async function proposeExistingBranch({
  cwd,
  api,
  branch,
  baseBranch,
  baseSha,
  dryRun,
  upstream,
}) {
  const fetched = await gitResult(cwd, [
    "fetch",
    "--no-tags",
    "--",
    "origin",
    `+refs/heads/${branch}:refs/remotes/rea-continuity/${branch}`,
  ]);
  if (!fetched.ok)
    throw new Error(
      `Could not inspect existing sync branch: ${sanitizeOutput(fetched.stderr, fetched.stdout)}`,
    );
  const ref = `refs/remotes/rea-continuity/${branch}`;
  const conflictRecord = await readRecord(cwd, ref, upstream.sha, "conflict");
  const syncRecord =
    conflictRecord === null
      ? await readRecord(cwd, ref, upstream.sha, "sync")
      : null;
  if (conflictRecord === null && syncRecord === null)
    throw new Error(
      `Remote branch ${branch} exists without a continuity record; inspect and remove it manually.`,
    );
  const conflicts = conflictRecord?.conflictPaths ?? [];
  const changedFiles = syncRecord?.changedFiles ?? [];
  if (dryRun)
    return {
      state: "dry-run",
      mergeable: conflictRecord === null,
      conflicts,
      upstreamSha: upstream.sha,
      baseSha,
      branch,
      changedFiles,
      existingBranch: true,
    };
  const pull = await createPull({
    api,
    branch,
    baseBranch,
    title:
      conflictRecord === null
        ? `chore(continuity): sync upstream ${upstream.sha.slice(0, 12)}`
        : `chore(continuity): resolve upstream conflict ${upstream.sha.slice(0, 12)}`,
    conflicts,
    upstreamSha: upstream.sha,
    baseSha,
    upstreamUrl: upstream.url,
    changedFiles,
  });
  return {
    state: conflictRecord === null ? "proposed" : "conflict-proposed",
    upstreamSha: upstream.sha,
    baseSha,
    branch,
    changedFiles,
    conflicts,
    pullRequest: { number: pull.number, url: pull.html_url },
  };
}

async function createPull({
  api,
  branch,
  baseBranch,
  title,
  conflicts,
  upstreamSha,
  baseSha,
  upstreamUrl,
  changedFiles,
}) {
  const lines = [
    "Automated upstream continuity proposal. This draft never merges itself.",
    "",
    `- Upstream: ${upstreamUrl}@\`${upstreamSha}\``,
    `- Base: \`${baseBranch}\` at \`${baseSha}\``,
    `- Merge result: ${conflicts.length === 0 ? "clean merge" : `${String(conflicts.length)} conflict(s)`}`,
  ];
  if (changedFiles.length > 0)
    lines.push(`- Upstream changes: ${String(changedFiles.length)} file(s)`);
  if (conflicts.length > 0) {
    lines.push(
      "",
      "### Conflicts preserved",
      "",
      "The base branch and local patches were not modified. Resolve locally:",
      "",
      "```sh",
      `git switch ${branch}`,
      `git merge ${upstreamSha}`,
      "# resolve each path, keep local patches, then commit and push",
      "```",
      "",
      ...conflicts.map((path) => `- \`${path}\``),
    );
  }
  lines.push(
    "",
    "### Review requirements",
    "",
    "- Review the full diff and run the normal validation gates.",
    "- Do not force-push, mirror, or auto-merge this branch.",
    "- Re-running the proposal is idempotent for this upstream revision.",
  );
  return api.createPullRequest({
    title,
    head: branch,
    base: baseBranch,
    body: `${lines.join("\n")}\n`,
  });
}

async function writeSyncRecord(worktree, upstreamSha, record) {
  const directory = await containedRecordDirectory(worktree, [
    ".github",
    "continuity",
    "upstream-sync",
  ]);
  await writeContainedFile(
    directory,
    `${upstreamSha}.json`,
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

async function writeConflictRecord(worktree, upstreamSha, record) {
  const directory = await containedRecordDirectory(worktree, [
    ".github",
    "continuity",
    "upstream-conflicts",
  ]);
  await writeContainedFile(
    directory,
    `${upstreamSha}.json`,
    `${JSON.stringify(record, null, 2)}\n`,
  );
  await writeContainedFile(
    directory,
    `${upstreamSha}.md`,
    conflictMarkdown(record),
  );
}

async function containedRecordDirectory(worktree, segments) {
  const root = await realpath(worktree);
  let current = root;
  for (const segment of segments) {
    const next = join(current, segment);
    const info = await lstatOrNull(next);
    if (info === null) {
      await mkdir(next);
    } else if (!info.isDirectory()) {
      throw new Error(
        `Continuity record path is not a physical directory: ${next}`,
      );
    }
    const resolved = await realpath(next);
    if (resolved !== next)
      throw new Error(
        `Continuity record path escapes the proposal worktree: ${next}`,
      );
    current = resolved;
  }
  return current;
}

async function writeContainedFile(directory, name, contents) {
  const path = join(directory, name);
  const info = await lstatOrNull(path);
  if (info !== null && !info.isFile())
    throw new Error(`Continuity record target is not a regular file: ${path}`);
  await writeFile(path, contents, "utf8");
  if ((await realpath(path)) !== path)
    throw new Error(`Continuity record write escaped containment: ${path}`);
}

async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch (cause) {
    if (cause?.code === "ENOENT") return null;
    throw cause;
  }
}

function conflictMarkdown(record) {
  return `# Upstream conflict ${record.upstream.sha.slice(0, 12)}\n\nBase \`${record.base.branch}\` at \`${record.base.sha}\` and the local branch were not modified.\n\nResolve locally:\n\n\`\`\`sh\ngit fetch ${record.upstream.url} ${record.upstream.ref}\ngit switch -c ${syncBranchFor(record.upstream.sha)} ${record.base.sha}\ngit merge ${record.upstream.sha}\n\`\`\`\n\nConflicting paths:\n${record.conflictPaths.map((path) => `- \`${path}\``).join("\n")}\n`;
}

async function readRecord(cwd, ref, upstreamSha, kind) {
  const directory =
    kind === "conflict" ? "upstream-conflicts" : "upstream-sync";
  const raw = await gitMaybe(cwd, [
    "show",
    `${ref}:.github/continuity/${directory}/${upstreamSha}.json`,
  ]);
  if (raw === null) return null;
  let record;
  try {
    record = JSON.parse(raw);
  } catch (cause) {
    throw new Error(
      `Existing continuity record for ${upstreamSha} is malformed`,
      {
        cause,
      },
    );
  }
  if (record?.schemaVersion !== 1 || record?.upstream?.sha !== upstreamSha)
    throw new Error(
      `Existing continuity record for ${upstreamSha} has mismatched identity`,
    );
  return record;
}

async function resolveBase(cwd, baseBranch) {
  const remote = await gitMaybe(cwd, [
    "rev-parse",
    "--verify",
    `refs/remotes/origin/${baseBranch}^{commit}`,
  ]);
  if (remote !== null && /^[a-f0-9]{40}$/u.test(remote)) return remote;
  return await resolveCommit(cwd, `refs/heads/${baseBranch}`);
}

async function configureCommitter(worktree) {
  await git(worktree, ["config", "user.name", "REA continuity bot"]);
  await git(worktree, [
    "config",
    "user.email",
    "continuity-bot@users.noreply.github.com",
  ]);
}

async function pushBranch(cwd, branch) {
  await git(cwd, ["push", "origin", `HEAD:refs/heads/${branch}`], {
    env: { GIT_TERMINAL_PROMPT: "0" },
  });
}

function validateInputs({ upstreamUrl, upstreamBranch, baseBranch }) {
  if (typeof upstreamUrl !== "string" || !SAFE_URL.test(upstreamUrl))
    throw new Error("Upstream must be an explicit URL or absolute path");
  for (const [name, value] of [
    ["upstreamBranch", upstreamBranch],
    ["baseBranch", baseBranch],
  ])
    if (
      typeof value !== "string" ||
      !SAFE_REF.test(value) ||
      value.includes("..") ||
      value.endsWith("/")
    )
      throw new Error(`${name} is not a safe branch name`);
}
