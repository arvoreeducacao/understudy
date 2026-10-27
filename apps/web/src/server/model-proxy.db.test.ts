import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { eq, inArray } from "drizzle-orm";

const url = process.env.TEST_DATABASE_URL;
const skip = !url && "set TEST_DATABASE_URL to a disposable Postgres to run";
if (url) process.env.DATABASE_URL = url;
process.env.BETTER_AUTH_SECRET ??= "test-secret";
process.env.UNDERSTUDY_ALLOW_PRIVATE_MCP = "1";

const ids = { owner: "usr_model_owner", keyed: "agt_model_keyed", plain: "agt_model_plain" };
const PROVIDER_KEY = "test-provider-key-0001";
const seen: { path: string; headers: IncomingMessage["headers"]; body: string }[] = [];
let provider: Server;
let panel: Server;
let panelUrl = "";

before(async () => {
  if (!url) return;
  provider = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    seen.push({ path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
    res.writeHead(200, { "Content-Type": "text/event-stream", "request-id": "req_test_1", "set-cookie": "a=b" });
    res.write("event: message_start\ndata: {}\n\n");
    res.end("event: message_stop\ndata: {}\n\n");
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/gateway`;

  await (await import("./test-db")).migrateTestDb();
  const { getDb, schema } = await import("@/lib/db");
  const { seal } = await import("@/lib/secret-box");
  const db = getDb();
  await db.delete(schema.user).where(eq(schema.user.id, ids.owner));
  await db.insert(schema.user).values({ id: ids.owner, name: "Rosa Lima", email: "model-owner@test.local", status: "approved" });
  const look = { body: "pill", color: "#7FB2FF", eyes: "dot", acc: "none", accColor: "#2F3A56" };
  const tools = { notifyOwner: true, slack: false, slackChannels: [] };
  await db.insert(schema.agents).values([
    { id: ids.keyed, ownerId: ids.owner, name: "Keyed", look, tokenHash: "model_hash_keyed", tools, brainAccount: { url: providerUrl, auth: "x-api-key", key: seal(PROVIDER_KEY), last4: "0001", maxUsdPerTurn: 2 } } as never,
    { id: ids.plain, ownerId: ids.owner, name: "Plain", look, tokenHash: "model_hash_plain", tools } as never,
  ]);

  const { handleModelProxy, isModelProxyRoute } = await import("./model-proxy");
  panel = createServer((req, res) => {
    const target = new URL(req.url ?? "/", "http://x");
    if (!isModelProxyRoute(target.pathname)) {
      res.writeHead(404);
      return res.end();
    }
    void handleModelProxy(req, res, target);
  });
  await new Promise<void>((resolve) => panel.listen(0, "127.0.0.1", resolve));
  panelUrl = `http://127.0.0.1:${(panel.address() as AddressInfo).port}`;
});

after(async () => {
  if (!url) return;
  const { getDb, schema, getPool } = await import("@/lib/db");
  await getDb().delete(schema.user).where(inArray(schema.user.id, [ids.owner]));
  provider.close();
  panel.close();
  await getPool().end();
});

const ask = (path: string, token: string, method = "POST") =>
  fetch(`${panelUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "anthropic-version": "2023-06-01", "anthropic-beta": "test-beta", cookie: "session=x" },
    ...(method === "POST" ? { body: JSON.stringify({ model: "claude-test", messages: [{ role: "user", content: "hi" }] }) } : {}),
  });

test("a call with the understudy's token reaches its provider with its key, and the stream comes back as it is", { skip }, async () => {
  const { modelToken } = await import("./model-proxy");
  const res = await ask("/api/model/v1/messages?beta=true", modelToken({ id: ids.keyed, tokenHash: "model_hash_keyed" }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  assert.equal(res.headers.get("request-id"), "req_test_1");
  assert.equal(res.headers.get("set-cookie"), null);
  assert.match(await res.text(), /message_start[\s\S]*message_stop/);
  const call = seen.at(-1);
  assert.equal(call?.path, "/gateway/v1/messages?beta=true");
  assert.equal(call?.headers["x-api-key"], PROVIDER_KEY);
  assert.equal(call?.headers.authorization, undefined);
  assert.equal(call?.headers.cookie, undefined);
  assert.equal(call?.headers["anthropic-version"], "2023-06-01");
  assert.equal(call?.headers["anthropic-beta"], "test-beta");
  assert.match(String(call?.body), /claude-test/);
});

test("a forged token, another understudy's token, an understudy without a key and other paths are refused", { skip }, async () => {
  const { modelToken } = await import("./model-proxy");
  const before = seen.length;
  assert.equal((await ask("/api/model/v1/messages", `mdl_${ids.keyed}.forged`)).status, 401);
  assert.equal((await ask("/api/model/v1/messages", modelToken({ id: ids.keyed, tokenHash: "another_hash" }))).status, 401);
  assert.equal((await ask("/api/model/v1/messages", modelToken({ id: ids.plain, tokenHash: "model_hash_plain" }))).status, 401);
  assert.equal((await ask("/api/model/v1/models", modelToken({ id: ids.keyed, tokenHash: "model_hash_keyed" }))).status, 404);
  assert.equal((await ask("/api/model/v1/messages", modelToken({ id: ids.keyed, tokenHash: "model_hash_keyed" }), "GET")).status, 404);
  assert.equal(seen.length, before);
});

test("the computer is told to use the key when it connects, and only when what it reports differs", { skip }, async () => {
  const { Hub } = await import("./hub");
  const { computerHandlers } = await import("./hub/computer-handlers");
  const { brainAccountKey, modelToken } = await import("./model-proxy");
  const hub = new Hub();
  const sent: { type: string; token?: string; maxUsdPerTurn?: number }[] = [];
  hub.sendToComputer = ((_: string, message: { type: string }) => {
    sent.push(message);
    return true;
  }) as typeof hub.sendToComputer;
  const hello = { type: "hello" as const, agentId: ids.keyed, version: "1", brains: [{ brain: "claude" as const, loggedIn: true }] };
  await computerHandlers.hello(hub, ids.keyed, hello);
  const token = modelToken({ id: ids.keyed, tokenHash: "model_hash_keyed" });
  assert.deepEqual(sent.find((m) => m.type === "set_brain_account"), { type: "set_brain_account", token, maxUsdPerTurn: 2 });
  sent.length = 0;
  await computerHandlers.hello(hub, ids.keyed, { ...hello, brainAccount: { key: brainAccountKey(token), maxUsdPerTurn: 2 } });
  assert.ok(!sent.some((m) => m.type === "set_brain_account"));
  await computerHandlers.hello(hub, ids.plain, { ...hello, agentId: ids.plain, brainAccount: { key: "stale" } });
  assert.deepEqual(sent.find((m) => m.type === "set_brain_account"), { type: "set_brain_account", token: "" });
});
