import { createSign } from "node:crypto";
import { env, type GithubApp } from "@/lib/env";
import { safeFetch } from "./safe-fetch";

const GITHUB_MCP_HOSTS = new Set(["api.githubcopilot.com"]);
const RENEW_BEFORE_MS = 5 * 60 * 1000;

type Cached = { key: string; token: Promise<{ token: string; expiresAt: number }> };

let cached: Cached | null = null;

function base64url(value: string) {
  return Buffer.from(value).toString("base64url");
}

export function appJwt(app: GithubApp, now = Date.now()) {
  const issuedAt = Math.floor(now / 1000) - 60;
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: issuedAt, exp: issuedAt + 9 * 60, iss: app.appId }));
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(app.privateKey, "base64url");
  return `${header}.${payload}.${signature}`;
}

export function isGithubMcp(url: string) {
  try {
    return GITHUB_MCP_HOSTS.has(new URL(url).host);
  } catch {
    return false;
  }
}

export function usesGithubApp(server: { url: string; headerValue: string | null; oauthClient: string | null }, app = env.githubApp) {
  return Boolean(app) && !server.headerValue && !server.oauthClient && isGithubMcp(server.url);
}

async function issueToken(app: GithubApp, fetcher: typeof fetch, now: number) {
  const response = await fetcher(`https://api.github.com/app/installations/${encodeURIComponent(app.installationId)}/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${appJwt(app, now)}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!response.ok) throw new Error(`GitHub refused a token for the app (${response.status})`);
  const body = (await response.json()) as { token?: string; expires_at?: string };
  const expiresAt = Date.parse(body.expires_at ?? "");
  if (!body.token || Number.isNaN(expiresAt)) throw new Error("GitHub answered without a token for the app");
  return { token: body.token, expiresAt };
}

export async function githubAppToken(app = env.githubApp, fetcher: typeof fetch = safeFetch, now = Date.now) {
  if (!app) throw new Error("no GitHub App is set on this server");
  const key = `${app.appId}:${app.installationId}`;
  if (cached?.key === key) {
    const current = await cached.token.catch(() => null);
    if (current && current.expiresAt - RENEW_BEFORE_MS > now()) return current.token;
  }
  const token = issueToken(app, fetcher, now());
  cached = { key, token };
  token.catch(() => {
    if (cached?.token === token) cached = null;
  });
  return (await token).token;
}

export function forgetGithubAppToken() {
  cached = null;
}
