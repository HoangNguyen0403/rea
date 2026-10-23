const API_VERSION = "2022-11-28";
const DEFAULT_BASE_URL = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 20_000;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

/** Create the small write-scoped GitHub surface the sync proposal needs. */
export function createGitHubApi({
  repository,
  token,
  baseUrl = process.env.REA_CONTINUITY_GITHUB_API_URL ?? DEFAULT_BASE_URL,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!REPOSITORY.test(repository))
    throw new Error("GitHub repository must be OWNER/REPO");
  if (typeof token !== "string" || token.length === 0)
    throw new Error("GH_TOKEN or GITHUB_TOKEN is required");
  const root = baseUrl.replace(/\/+$/u, "");

  const request = async (method, path, body) => {
    const response = await fetchImpl(`${root}/repos/${repository}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": "rea-continuity-sync",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (!response.ok)
      throw new Error(
        `GitHub ${method} ${path} failed with ${String(response.status)}: ${text.slice(0, 500)}`,
      );
    try {
      return text.length === 0 ? null : JSON.parse(text);
    } catch (cause) {
      throw new Error(`GitHub ${method} ${path} returned malformed JSON`, {
        cause,
      });
    }
  };

  return {
    async listOpenPullRequests(baseBranch) {
      const path = `/pulls?state=open&base=${encodeURIComponent(baseBranch)}&per_page=100`;
      const pulls = await request("GET", path);
      if (!Array.isArray(pulls))
        throw new Error("GitHub pull request listing was not an array");
      return pulls;
    },
    async createPullRequest({ title, head, base, body }) {
      const pull = await request("POST", "/pulls", {
        title,
        head,
        base,
        body,
        draft: true,
        maintainer_can_modify: false,
      });
      if (
        typeof pull !== "object" ||
        pull === null ||
        typeof pull.number !== "number" ||
        typeof pull.html_url !== "string"
      )
        throw new Error("GitHub pull request creation omitted its identity");
      return pull;
    },
  };
}
