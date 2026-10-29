import type { Hub } from "./hub";
import { authenticateComputer, gateGitPush, githubGitAccess } from "./gatekeeper";
import { githubAppToken } from "./github-app";
import type { GitProxyDeps } from "./git-proxy";
import { safeFetch } from "./safe-fetch";

type ComputerAgent = NonNullable<Awaited<ReturnType<typeof authenticateComputer>>>;

export async function githubDefaultBranch(owner: string, repo: string, token: string, fetcher: typeof fetch = safeFetch) {
  const response = await fetcher(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { default_branch?: unknown };
  return typeof body.default_branch === "string" ? body.default_branch : null;
}

export function gitProxyDeps(hub: Hub): GitProxyDeps<ComputerAgent> {
  return {
    authenticate: authenticateComputer,
    access: githubGitAccess,
    token: () => githubAppToken(),
    defaultBranch: (owner, repo, token) => githubDefaultBranch(owner, repo, token),
    gatePush: (agent, push, onAsk, signal) => gateGitPush(hub, agent, push, onAsk, signal),
    upstream: "https://github.com",
    fetch: safeFetch,
  };
}
