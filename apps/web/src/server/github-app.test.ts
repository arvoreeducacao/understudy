import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, test } from "node:test";
import { featuredFor } from "@/lib/connector-showcase";
import { withServerApp } from "./connector-clients";
import { appJwt, forgetGithubAppToken, githubAppToken, isGithubMcp, usesGithubApp } from "./github-app";

const GITHUB = "https://api.githubcopilot.com/mcp/";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const app = { appId: "12345", installationId: "678", privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString() };
const saved = { GITHUB_APP_ID: process.env.GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID: process.env.GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY };

afterEach(() => {
  forgetGithubAppToken();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function decode(part: string) {
  return JSON.parse(Buffer.from(part, "base64url").toString());
}

function issuer(expiresIn: number, now: () => number) {
  const calls: { url: string; auth: string }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: (init.headers as Record<string, string>).Authorization });
    return new Response(JSON.stringify({ token: `ghs_${calls.length}`, expires_at: new Date(now() + expiresIn).toISOString() }), { status: 201 });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

test("the app proves itself with a short JWT signed by its private key", () => {
  const now = Date.UTC(2026, 9, 27, 12);
  const [header, payload, signature] = appJwt(app, now).split(".");
  assert.deepEqual(decode(header), { alg: "RS256", typ: "JWT" });
  const claims = decode(payload);
  assert.equal(claims.iss, "12345");
  assert.ok(claims.iat <= now / 1000 && claims.exp - claims.iat <= 10 * 60);
  assert.ok(createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, signature, "base64url"));
});

test("an installation token is reused until five minutes before it expires", async () => {
  let clock = Date.UTC(2026, 9, 27, 12);
  const now = () => clock;
  const { calls, fetcher } = issuer(60 * 60 * 1000, now);
  assert.equal(await githubAppToken(app, fetcher, now), "ghs_1");
  clock += 50 * 60 * 1000;
  assert.equal(await githubAppToken(app, fetcher, now), "ghs_1");
  clock += 6 * 60 * 1000;
  assert.equal(await githubAppToken(app, fetcher, now), "ghs_2");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://api.github.com/app/installations/678/access_tokens");
  assert.match(calls[0].auth, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
});

test("a refused token is not kept, so the next call asks again", async () => {
  let refuse = true;
  const fetcher = (async () => (refuse ? new Response("{}", { status: 401 }) : new Response(JSON.stringify({ token: "ghs_ok", expires_at: new Date(Date.now() + 3600_000).toISOString() }), { status: 201 }))) as unknown as typeof fetch;
  await assert.rejects(githubAppToken(app, fetcher), /401/);
  refuse = false;
  assert.equal(await githubAppToken(app, fetcher), "ghs_ok");
});

test("only a GitHub connector without its own key or sign-in uses the server's app", () => {
  const server = { url: GITHUB, headerValue: null, oauthClient: null };
  assert.equal(usesGithubApp(server, app), true);
  assert.equal(usesGithubApp(server, null), false);
  assert.equal(usesGithubApp({ ...server, headerValue: "sealed-key" }, app), false);
  assert.equal(usesGithubApp({ ...server, oauthClient: "sealed-client" }, app), false);
  assert.equal(usesGithubApp({ ...server, url: "https://mcp.example.com/" }, app), false);
  assert.equal(isGithubMcp("not a url"), false);
});

test("with the app set, connecting GitHub asks for no key", () => {
  const github = featuredFor(GITHUB)!;
  delete process.env.GITHUB_APP_ID;
  assert.equal(withServerApp(github), github);
  process.env.GITHUB_APP_ID = "12345";
  process.env.GITHUB_APP_INSTALLATION_ID = "678";
  process.env.GITHUB_APP_PRIVATE_KEY = app.privateKey.replace(/\n/g, "\\n");
  const connector = withServerApp(github);
  assert.equal(connector.serverApp, true);
  assert.equal(connector.headerName, undefined);
  assert.equal(withServerApp({ ...github, url: "https://mcp.example.com/" }).serverApp, undefined);
});
