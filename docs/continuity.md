# Fork continuity

This fork keeps an owned recovery path for static JavaScript analysis. It does
not publish the `rea-agents` npm package or the upstream MCP Registry identity,
and it does not install analysis engines. Ghidra, IDA, Hopper, and other engines
remain user-provided.

## Upstream sync proposals

`.github/workflows/upstream-sync.yml` runs on a daily schedule and by manual
dispatch. It checks out the fork's trusted `main` only; there is no
`pull_request` or `pull_request_target` trigger, so unreviewed code never
receives the write token. The workflow does not auto-merge, force-push, or
mirror upstream.

```sh
node scripts/continuity/propose-upstream-sync.mjs \
  --repository OWNER/REPO \
  --upstream-url https://github.com/morluto/rea.git \
  --base-branch main
```

The proposal branch is deterministic: `continuity/upstream-<sha12>`. Re-running
for the same upstream revision is a no-op. If any other sync proposal is open,
the run reports `pending-review` and creates nothing. A clean merge becomes a
draft pull request. A conflict becomes a draft pull request containing
`.github/continuity/upstream-conflicts/<sha>.json` and `.md`; the base branch and
local patches are not modified. Resolve the conflict locally, keep the local
patches, and push the reviewed result. Record writes reject symlink or
non-directory ancestors before touching the proposal worktree.

`--dry-run` inspects mergeability without pushing or creating a pull request,
including when a proposal branch already exists on `origin`.

## Retained recovery bundle

The bundle contains:

- the packed npm archive with built `dist/`, the CLI launcher, and the shipped
  skill;
- the exact source revision (`source.tar.gz`) and pinned content for
  `third_party/wakaru`;
- the actual installed production dependency tree for the build platform,
  including transitive packages and optional platform artifacts that were
  present;
- source and dependency license notices, with dependency notices retained under
  each package's physical `node_modules` path so duplicate name/version installs
  do not overwrite one another;
- the packed vendor skill (`skills/reverse-engineer-anything/SKILL.md`) with its
  metadata version and digest recorded in `vendorSkill`;
- `manifest.json` and `inventory.jsonl` with SHA-256 digests for every file.

A clean build records `source.clean: true` and `source.worktree: null`. For
local verification only, `--allow-dirty` records `source.clean: false`, the
`HEAD` revision, `source-worktree.patch`, and `source-untracked.tar.gz`. The
bundle is never labeled clean and the patch names every changed path. Release
automation does not pass `--allow-dirty`.

A lockfile digest is recorded for provenance, but it is not evidence of
completeness. Verification binds the retained root set to the packed package's
required declarations, then resolves every required edge in the retained tree
and checks the actual package identity and semver range. Optional roots that are
absent on the build platform are reported, not treated as required. Only
`package.json` files at installed `node_modules` package roots define dependency
graph nodes; package-internal metadata remains inventoried and digest-checked
without becoming a phantom dependency. Dependency range evaluation is bundled
from the pinned `semver` implementation; recovery does not install npm packages
or use a handwritten range parser.

## Trusted verification and restore

A consumer must obtain, separately from the candidate bundle:

1. an externally trusted SHA-256 of the candidate `manifest.json`;
2. the trusted recovery bootstrap archive and its independently trusted
   SHA-256/review record.

The bootstrap archive contains self-contained
`verify-retained-bundle.mjs`, `restore-retained-bundle.mjs`,
`rollback-retained-install.mjs`, and `smoke-static-js.mjs`, their shared chunks,
the project license/notices, and the pinned `semver` license. It uses only Node
standard-library builtins at runtime; `semver` is bundled. Never calculate the
trusted manifest digest from the same untrusted download, and never load code
from the candidate bundle before verification.

```sh
TRUSTED_TOOLS=/path/to/authenticated-bootstrap
CANDIDATE=/path/to/extracted-bundle
TRUSTED_MANIFEST_SHA256=<externally reviewed 64-hex digest>

node "$TRUSTED_TOOLS/verify-retained-bundle.mjs" "$CANDIDATE" \
  --manifest-sha256 "$TRUSTED_MANIFEST_SHA256"

node "$TRUSTED_TOOLS/restore-retained-bundle.mjs" \
  --bundle "$CANDIDATE" --install-dir "$HOME/.rea-continuity" \
  --manifest-sha256 "$TRUSTED_MANIFEST_SHA256" --replace

node "$TRUSTED_TOOLS/smoke-static-js.mjs" --install-dir "$HOME/.rea-continuity"
```

`verify` hashes the raw manifest bytes before parsing and before loading any
candidate code. A missing or malformed trusted digest is a usage failure; a
mismatch fails before restore changes install state. Restore independently
re-verifies the digest and inventory; a prior verify run is not sufficient.
Verification additionally rejects missing files, digest mismatches, symlinks and
other non-regular bundle entries, tar link/hard-link members, unsafe paths,
unlisted files, undeclared or missing packed roots, incompatible transitive
versions, and foreign platform/Node combinations. `--allow-foreign-platform` is
for inspection only; restore always requires the exact build platform,
architecture, and Node version. Archive member types are checked before
extraction independently of inventory-path checks.

Restore extracts the package archive and copies the retained dependency tree
without network access. With `--replace`, the existing install is atomically
moved to a sibling `*.previous-<timestamp>` directory before activation.
Sidecar publication is transactional: an existing owned sidecar is preserved on
failure, unrelated or symlinked sidecars are rejected, and failed activation
restores the prior install. Rollback stages replacement metadata before moving
either install; a failed publication compensates the directory swap, and any
compensation failure reports the exact retained recovery paths without deleting
the remaining candidates.

```sh
node "$TRUSTED_TOOLS/rollback-retained-install.mjs" \
  --install-dir "$HOME/.rea-continuity"
```

The smoke test analyzes only a synthetic local JavaScript fixture. It launches
the restored CLI with an explicit minimal environment, not the ambient
credential environment. It does not run an engine against a real target. MCP
acceptance for the same static lane is the `analyze_javascript_application` tool
with `{"input_path":"<absolute synthetic fixture directory>"}`; existing
`scripts/lib/release-package-canary.mjs` covers the MCP handshake and canonical
tool catalog but not that analysis call.

## Maintainer build

```sh
node scripts/continuity/build-retained-bundle.mjs \
  --output .cache/continuity-bundle --source .
node scripts/continuity/build-bootstrap.mjs \
  --output .cache/continuity-bootstrap
```

Build requires a clean checkout whose worktree matches `HEAD`, an exact
supported Node runtime, initialized pinned submodule content, and installed
dependencies. The bundle receipt includes `manifestSha256`; the retention
workflow propagates that freshly built value into verification, restore, and the
retained release. The source entrypoints under `scripts/continuity/` remain the
maintainer development interface; the generated bootstrap files at the output
root are the consumer interface.

## Independent backup and release authority

The retention workflow creates a **draft** GitHub Release with two separately
checksummed archives: the retained bundle and the recovery bootstrap. A second
file on the same release is not an independent backup. The operator-owned
procedure is:

1. On an authorized host, download the draft assets, record both SHA-256 values
   and the authenticated manifest digest in the review/retention record.
2. Copy both archives plus the digest record into an operator-controlled,
   access-controlled vault or offline medium separate from GitHub, the upstream
   repository, and the build host.
3. Re-verify the copied bundle with the copied bootstrap using
   `--manifest-sha256` before accepting the backup.
4. Record the copy location, custody owner, retrieval date, and verification
   result in the same review record.

No backup destination, upload, or external publication is configured or
activated by this repository. An actually retained independent backup is not
claimed until that operator evidence exists. The draft workflow refuses to
overwrite an existing release and never publishes to npm or the MCP Registry.
The `continuity-release` environment must be configured with required
reviewers; the YAML declares it but cannot prove the protection rule exists.

## Exit codes

The continuity CLIs return `0` for success or an intentional no-op, `1` for a
verification, compatibility, restore, or operational failure, and `2` for a
usage error.
