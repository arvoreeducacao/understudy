import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { eq, like } from "drizzle-orm";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const url = process.env.TEST_DATABASE_URL;
const skip = !url && "set TEST_DATABASE_URL to a disposable Postgres to run";
if (url) process.env.DATABASE_URL = url;
process.env.BETTER_AUTH_SECRET ??= "test-secret";
process.env.UNDERSTUDY_ALLOW_PRIVATE_MCP = "1";
process.env.UNDERSTUDY_PUBLIC_URL = "https://understudy.test";

const provider = {
  registers: true,
  challenge: "",
  validTokens: new Set<string>(),
  issued: 0,
  tokenRequests: [] as URLSearchParams[],
};

let upstream: Server;
let plain: Server;
let base = "";
let plainBase = "";

async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

function json(res: import("node:http").ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

function issue(res: import("node:http").ServerResponse) {
  provider.issued += 1;
  const access = `access_${provider.issued}`;
  provider.validTokens.add(access);
  json(res, 200, { access_token: access, refresh_token: `refresh_${provider.issued}`, token_type: "Bearer", expires_in: 3600 });
}

before(async () => {
  upstream = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path.startsWith("/.well-known/oauth-protected-resource")) return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
    if (path === "/.well-known/oauth-authorization-server")
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        ...(provider.registers ? { registration_endpoint: `${base}/register` } : {}),
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: provider.registers ? ["none"] : ["client_secret_post"],
      });
    if (path === "/register" && req.method === "POST") {
      const metadata = JSON.parse(await body(req));
      return json(res, 201, { ...metadata, client_id: "registered_client" });
    }
    if (path === "/token" && req.method === "POST") {
      const form = new URLSearchParams(await body(req));
      provider.tokenRequests.push(form);
      if (form.get("grant_type") === "authorization_code") {
        const verifier = form.get("code_verifier") ?? "";
        const matches = createHash("sha256").update(verifier).digest("base64url") === provider.challenge;
        if (form.get("code") !== "good-code" || !matches) return json(res, 400, { error: "invalid_grant" });
        if (!provider.registers && form.get("client_secret") !== "app-secret") return json(res, 401, { error: "invalid_client" });
        return issue(res);
      }
      if (form.get("grant_type") === "refresh_token" && form.get("refresh_token")?.startsWith("refresh_")) return issue(res);
      return json(res, 400, { error: "invalid_grant" });
    }
    if (path !== "/mcp") {
      res.writeHead(404);
      res.end();
      return;
    }
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    if (!provider.validTokens.has(bearer)) {
      res.writeHead(401, { "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const raw = await body(req);
    const mcp = new McpServer({ name: "crm", version: "1" });
    mcp.registerTool("list_deals", { description: "List deals", inputSchema: {} }, async () => ({ content: [{ type: "text", text: "[]" }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
  });
  plain = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => plain.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  plainBase = `http://127.0.0.1:${(plain.address() as AddressInfo).port}`;
  if (!url) return;
  await (await import("./test-db")).migrateTestDb();
});

after(async () => {
  upstream?.close();
  plain?.close();
  if (!url) return;
  const { getDb, getPool, schema } = await import("@/lib/db");
  await getDb().delete(schema.mcpServers).where(like(schema.mcpServers.id, "mcp_oauth_%"));
  await getPool().end();
});

async function insert(id: string, client: unknown) {
  const { getDb, schema } = await import("@/lib/db");
  const { seal } = await import("@/lib/secret-box");
  await getDb().delete(schema.mcpServers).where(eq(schema.mcpServers.id, id));
  const [row] = await getDb()
    .insert(schema.mcpServers)
    .values({ id, name: "CRM", slug: id, url: `${base}/mcp`, oauthClient: seal(JSON.stringify(client)) })
    .returning();
  return row;
}

function authorizePage(address: string) {
  const page = new URL(address);
  provider.challenge = page.searchParams.get("code_challenge") ?? "";
  return page;
}

test("tells a sign-in server apart from one that has none", { skip }, async () => {
  const { oauthSupport } = await import("./connector-oauth");
  provider.registers = true;
  assert.deepEqual(await oauthSupport(`${base}/mcp`), { supported: true, registers: true });
  provider.registers = false;
  assert.deepEqual(await oauthSupport(`${base}/mcp`), { supported: true, registers: false });
  assert.deepEqual(await oauthSupport(`${plainBase}/mcp`), { supported: false });
});

test("signs in by registering itself, then the connector works with the token kept sealed", { skip }, async () => {
  const { beginSignIn, finishSignIn } = await import("./connector-oauth");
  const { listUpstreamTools, forgetServer } = await import("./upstream");
  provider.registers = true;
  const row = await insert("mcp_oauth_dynamic", null);

  const page = authorizePage(await beginSignIn(row));
  assert.equal(page.origin + page.pathname, `${base}/authorize`);
  assert.equal(page.searchParams.get("client_id"), "registered_client");
  assert.equal(page.searchParams.get("redirect_uri"), "https://understudy.test/api/connectors/oauth/callback");
  const state = page.searchParams.get("state") ?? "";
  assert.ok(state.length >= 32);

  const finished = await finishSignIn(state, "good-code");
  assert.ok(finished?.signedIn);
  assert.equal(finished.server.oauthState, null);
  assert.equal(finished.server.oauthVerifier, null);
  assert.ok(finished.server.oauthTokens && !finished.server.oauthTokens.includes("access_"));

  forgetServer(row.id);
  assert.deepEqual(
    (await listUpstreamTools(finished.server)).map((tool) => tool.name),
    ["list_deals"],
  );
  assert.equal(await finishSignIn(state, "good-code"), null);
});

test("an expired token is renewed on its own and the new one is saved", { skip }, async () => {
  const { beginSignIn, finishSignIn } = await import("./connector-oauth");
  const { listUpstreamTools, forgetServer } = await import("./upstream");
  const { getDb, schema } = await import("@/lib/db");
  provider.registers = true;
  const row = await insert("mcp_oauth_refresh", null);
  const page = authorizePage(await beginSignIn(row));
  const finished = await finishSignIn(page.searchParams.get("state") ?? "", "good-code");
  assert.ok(finished?.signedIn);

  provider.validTokens.clear();
  forgetServer(row.id);
  assert.deepEqual(
    (await listUpstreamTools(finished.server)).map((tool) => tool.name),
    ["list_deals"],
  );
  const [saved] = await getDb().select().from(schema.mcpServers).where(eq(schema.mcpServers.id, row.id));
  assert.notEqual(saved.oauthTokens, finished.server.oauthTokens);
  assert.equal(provider.tokenRequests.at(-1)?.get("grant_type"), "refresh_token");
});

test("a system that needs its own app signs in with that app's id and secret", { skip }, async () => {
  const { beginSignIn, finishSignIn } = await import("./connector-oauth");
  provider.registers = false;
  const row = await insert("mcp_oauth_app", { client_id: "my-app", client_secret: "app-secret" });
  const page = authorizePage(await beginSignIn(row));
  assert.equal(page.searchParams.get("client_id"), "my-app");
  const finished = await finishSignIn(page.searchParams.get("state") ?? "", "good-code");
  assert.ok(finished?.signedIn);
  assert.equal(provider.tokenRequests.at(-1)?.get("client_secret"), "app-secret");
});

test("a wrong code or an unknown state connects nothing", { skip }, async () => {
  const { beginSignIn, finishSignIn } = await import("./connector-oauth");
  provider.registers = true;
  const row = await insert("mcp_oauth_wrong", null);
  const page = authorizePage(await beginSignIn(row));
  const finished = await finishSignIn(page.searchParams.get("state") ?? "", "stolen-code");
  assert.equal(finished?.signedIn, false);
  assert.equal(finished?.server.oauthTokens, null);
  assert.equal(await finishSignIn("made-up-state", "good-code"), null);
});

test("a sign-in page that is not a web address is never handed to the browser", { skip }, async () => {
  const { beginSignIn } = await import("./connector-oauth");
  provider.registers = false;
  const row = await insert("mcp_oauth_script", { client_id: "my-app", client_secret: "app-secret" });
  const original = upstream.listeners("request")[0] as (req: IncomingMessage, res: import("node:http").ServerResponse) => void;
  upstream.removeAllListeners("request");
  upstream.on("request", (req, res) => {
    if (new URL(req.url ?? "/", "http://x").pathname !== "/.well-known/oauth-authorization-server") return original(req, res);
    json(res, 200, {
      issuer: base,
      authorization_endpoint: "javascript:alert(1)",
      token_endpoint: `${base}/token`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
    });
  });
  try {
    await assert.rejects(beginSignIn(row));
  } finally {
    upstream.removeAllListeners("request");
    upstream.on("request", original);
  }
});
