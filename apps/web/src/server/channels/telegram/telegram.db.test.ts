import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { after, before, beforeEach, test } from "node:test";
import { eq, inArray } from "drizzle-orm";

const url = process.env.TEST_DATABASE_URL;
const skip = !url && "set TEST_DATABASE_URL to a disposable Postgres to run";
if (url) process.env.DATABASE_URL = url;
process.env.BETTER_AUTH_SECRET ??= "test-secret";
process.env.UNDERSTUDY_PUBLIC_URL = "http://localhost:3999";
process.env.UNDERSTUDY_TELEGRAM_API_URL = "https://telegram.example.com";

const ids = { owner: "usr_tg_owner", agent: "agt_tg" };
const look = { body: "pill", color: "#7FB2FF", eyes: "dot", acc: "none", accColor: "#2F3A56" };
const tools = { notifyOwner: true, slack: false, slackChannels: [] };
const TOKEN = "123456789:AAexampleexampleexampleexampleexam";
const OWNER_TG = 111111;
const STRANGER_TG = 222222;

type Call = { method: string; body: Record<string, unknown> };
const calls: Call[] = [];
let nextMessageId = 500;
let botId = 987654321;

async function fakeTelegram(input: string | URL | Request, init?: RequestInit) {
  const target = String(input);
  if (target.includes("/file/bot")) return new Response(Buffer.from("%PDF-1.4 fake"));
  const method = target.split("/").pop() as string;
  const body = init?.body instanceof FormData ? Object.fromEntries([...init.body.entries()].map(([key, value]) => [key, typeof value === "string" ? value : `file:${(value as File).name}`])) : JSON.parse(String(init?.body ?? "{}"));
  calls.push({ method, body });
  const results: Record<string, unknown> = {
    getMe: { id: botId, is_bot: true, username: "ada_example_bot" },
    getFile: { file_path: "documents/file_1.pdf", file_size: 13 },
  };
  return Response.json({ ok: true, result: results[method] ?? (method.startsWith("send") ? { message_id: nextMessageId++ } : true) });
}

function fakeComputer() {
  const ws = Object.assign(new EventEmitter(), {
    OPEN: 1,
    readyState: 1,
    received: [] as Record<string, unknown>[],
    send(raw: string) {
      ws.received.push(JSON.parse(raw));
    },
    ping() {},
    close() {
      ws.readyState = 3;
      ws.emit("close");
    },
  });
  return ws;
}

async function settle(ms = 50) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

before(async () => {
  if (!url) return;
  await (await import("../../test-db")).migrateTestDb();
  const { getDb, schema } = await import("@/lib/db");
  const db = getDb();
  await db.delete(schema.user).where(eq(schema.user.id, ids.owner));
  await db.insert(schema.user).values({ id: ids.owner, name: "Maya", email: "maya-tg@example.com", status: "approved" });
  await db.insert(schema.agents).values({ id: ids.agent, ownerId: ids.owner, name: "Ada", look, tokenHash: "tg_hash", tools, computerStatus: "running", lastSeenAt: new Date() } as never);
  const { setTelegramFetch } = await import("./api");
  setTelegramFetch(fakeTelegram as typeof fetch);
});

beforeEach(async () => {
  if (!url) return;
  calls.length = 0;
  const { getDb, schema } = await import("@/lib/db");
  await getDb().delete(schema.messages).where(eq(schema.messages.agentId, ids.agent));
  botId = 987654321;
  const { disconnectTelegram, connectTelegram } = await import("./connect");
  await disconnectTelegram(ids.agent);
  assert.deepEqual(await connectTelegram(ids.agent, TOKEN), { ok: true, username: "ada_example_bot" });
  calls.length = 0;
});

after(async () => {
  if (!url) return;
  const { getDb, schema, getPool } = await import("@/lib/db");
  await getDb().delete(schema.user).where(inArray(schema.user.id, [ids.owner]));
  await getPool().end();
  setTimeout(() => process.exit(0), 100).unref();
});

async function connected() {
  const { Hub } = await import("../../hub");
  const hub = new Hub();
  const ws = fakeComputer();
  await hub.attachComputer(ws as never, ids.agent);
  return { hub, ws };
}

let updateId = 1000;

function message(fromId: number, text: string, extra: Record<string, unknown> = {}) {
  return { update_id: updateId++, message: { message_id: updateId, from: { id: fromId, first_name: fromId === OWNER_TG ? "Maya" : "Sam", username: fromId === OWNER_TG ? "maya_example" : "sam_example" }, chat: { id: fromId, type: "private" }, text, ...extra } };
}

async function addressed() {
  const { channelByAddress } = await import("../store");
  return (await channelByAddress("telegram", String(botId)))!;
}

async function send(hub: unknown, update: unknown) {
  const { processTelegramUpdate } = await import("./webhook");
  return processTelegramUpdate(hub as never, await addressed(), update as never);
}

async function pair(hub: unknown) {
  const { channelSettings } = await import("../settings");
  const link = (await channelSettings(ids.agent)).telegram.pairLink as string;
  const code = new URL(link).searchParams.get("start") as string;
  return send(hub, message(OWNER_TG, `/start ${code}`));
}

test("connecting stores the bot token sealed and falls back to polling without a public HTTPS address", { skip }, async () => {
  const { getDb, schema } = await import("@/lib/db");
  const [row] = await getDb().select().from(schema.agentChannels).where(eq(schema.agentChannels.agentId, ids.agent));
  assert.equal(row.kind, "telegram");
  assert.ok(row.secret && !row.secret.includes(TOKEN));
  assert.equal((row.settings as { mode: string }).mode, "poll");
  const { connectTelegram } = await import("./connect");
  assert.deepEqual(await connectTelegram(ids.agent, "not-a-token"), { ok: false, error: "bad_token" });
});

test("the owner links their account once, then talks to the understudy and gets the reply in the same chat", { skip }, async () => {
  const { hub, ws } = await connected();
  const { channelSettings } = await import("../settings");
  const link = (await channelSettings(ids.agent)).telegram.pairLink as string;
  assert.match(link, /^https:\/\/t\.me\/ada_example_bot\?start=[A-Za-z0-9]{24}$/);
  const code = new URL(link).searchParams.get("start") as string;
  assert.equal(await send(hub, message(STRANGER_TG, "/start wrongcode")), "held");
  assert.equal(await send(hub, message(OWNER_TG, `/start ${code}`)), "paired");
  assert.equal(await send(hub, message(STRANGER_TG, `/start ${code}`)), "held");
  const view = await channelSettings(ids.agent);
  assert.equal(view.telegram.pairLink, null);
  assert.equal(view.telegram.ownerName, "Maya @maya_example");

  assert.equal(await send(hub, message(OWNER_TG, "What is on my calendar?")), "delivered");
  const chat = ws.received.find((m) => m.type === "chat") as { text: string; from: string; external?: unknown };
  assert.deepEqual([chat.text, chat.from, chat.external], ["What is on my calendar?", "Maya", undefined]);

  const { computerHandlers } = await import("../../hub/computer-handlers");
  await computerHandlers.turn(hub, ids.agent, { type: "turn", origin: (chat as unknown as { origin: string }).origin } as never);
  await computerHandlers.chat(hub, ids.agent, { type: "chat", role: "understudy", text: "Two meetings today." } as never);
  await computerHandlers.state(hub, ids.agent, { type: "state", state: "calm" } as never);
  await settle(100);
  const reply = calls.find((call) => call.method === "sendMessage" && call.body.text === "Two meetings today.");
  assert.equal(reply?.body.chat_id, String(OWNER_TG));
});

test("strangers are held, allowed usernames arrive as someone else, and files come along", { skip }, async () => {
  const { hub, ws } = await connected();
  await pair(hub);
  assert.equal(await send(hub, message(STRANGER_TG, "Hi, can you help?")), "held");
  assert.equal(ws.received.filter((m) => m.type === "chat").length, 0);
  const { setChannelSenders } = await import("../settings");
  assert.equal(await setChannelSenders(ids.agent, "telegram", "@Sam_Example, not valid!, 12"), "sam_example");
  const outcome = await send(hub, message(STRANGER_TG, "", { caption: "Here is the invoice", document: { file_id: "f1", file_name: "invoice.pdf", mime_type: "application/pdf", file_size: 13 } }));
  assert.equal(outcome, "delivered");
  const put = ws.received.find((m) => m.type === "file_put") as { path: string; base64: string };
  assert.match(put.path, /^telegram\/.+-invoice\.pdf$/);
  assert.equal(Buffer.from(put.base64, "base64").toString(), "%PDF-1.4 fake");
  const chat = ws.received.find((m) => m.type === "chat") as { external?: { channel: string; sender: string }; attachments?: { name: string }[] };
  assert.deepEqual(chat.external, { channel: "telegram", sender: "Sam @sam_example (222222)" });
  assert.equal(chat.attachments?.[0].name, "invoice.pdf");
});

test("approvals during a Telegram conversation come with buttons only the owner can press", { skip }, async () => {
  const { hub } = await connected();
  await pair(hub);
  await send(hub, message(OWNER_TG, "Pay the invoice"));
  calls.length = 0;
  const approvalId = await hub.approvals.create(ids.agent, { summary: "Pay invoice 7 for 120.00", fields: [{ label: "Amount", value: "120.00" }] }, "mcp");
  await settle(100);
  const notice = calls.find((call) => call.method === "sendMessage" && JSON.stringify(call.body.reply_markup ?? "").includes(approvalId));
  assert.ok(notice);
  assert.equal(notice.body.chat_id, String(OWNER_TG));
  assert.match(String(notice.body.text), /Pay invoice 7 for 120\.00/);
  const press = (fromId: number, data: string) => ({ update_id: updateId++, callback_query: { id: `cb${updateId}`, from: { id: fromId }, data, message: { message_id: 9, chat: { id: fromId, type: "private" }, text: "Ada needs your OK" } } });
  assert.equal(await send(hub, press(STRANGER_TG, `apr:${approvalId}:y`)), "not_owner");
  assert.equal(await send(hub, press(OWNER_TG, `apr:${approvalId}:y`)), "answered");
  assert.equal(await send(hub, press(OWNER_TG, `apr:${approvalId}:n`)), "closed");
  const { getDb, schema } = await import("@/lib/db");
  const [row] = await getDb().select().from(schema.approvals).where(eq(schema.approvals.id, approvalId));
  assert.deepEqual([row.status, row.answeredBy], ["approved", ids.owner]);
});

test("a connector approval that may be remembered gets an always-allow button that approves", { skip }, async () => {
  const { hub } = await connected();
  await pair(hub);
  await send(hub, message(OWNER_TG, "Draft the reply"));
  calls.length = 0;
  const approvalId = await hub.approvals.create(ids.agent, { summary: "Use create_draft on Mail", fields: [{ label: "to", value: "client@example.com" }] }, "mcp", undefined, undefined, { serverId: "mcp_absent", tool: "create_draft" });
  await settle(100);
  const notice = calls.find((call) => call.method === "sendMessage" && JSON.stringify(call.body.reply_markup ?? "").includes(approvalId));
  assert.ok(notice);
  assert.ok(JSON.stringify(notice.body.reply_markup).includes(`apr:${approvalId}:a`));
  const press = { update_id: updateId++, callback_query: { id: `cb${updateId}`, from: { id: OWNER_TG }, data: `apr:${approvalId}:a`, message: { message_id: 9, chat: { id: OWNER_TG, type: "private" }, text: "Ada needs your OK" } } };
  assert.equal(await send(hub, press), "answered");
  const { getDb, schema } = await import("@/lib/db");
  const [row] = await getDb().select().from(schema.approvals).where(eq(schema.approvals.id, approvalId));
  assert.equal(row.status, "approved");
});

test("the webhook only accepts Telegram's secret header for that channel", { skip }, async () => {
  const { hub } = await connected();
  const { handleTelegramWebhook } = await import("./webhook");
  const { webhookSecret } = await import("./keys");
  const channel = (await addressed()).channel;
  const call = async (secret: string, body: unknown) => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: "POST", headers: { "x-telegram-bot-api-secret-token": secret }, socket: { remoteAddress: "203.0.113.5" } });
    let status = 0;
    const res = { headersSent: false, writeHead: (code: number) => void (status = code), end: () => undefined };
    await handleTelegramWebhook(hub, req as never, res as never, `/api/channels/telegram/${channel.id}`);
    return status;
  };
  assert.equal(await call("wrong", message(OWNER_TG, "hi")), 401);
  assert.equal(await call(webhookSecret(channel.id), message(STRANGER_TG, "hello there")), 200);
  const { channelSettings } = await import("../settings");
  assert.equal((await channelSettings(ids.agent)).telegram.held.length, 1);
});

test("Slack and Telegram share one reply path: the conversation that spoke last gets the answer", { skip }, async () => {
  const { hub } = await connected();
  await pair(hub);
  const { currentConversation } = await import("../relay");
  const { setThread } = await import("../../slack-threads");
  await setThread(ids.agent, { channel: "D123", threadTs: "1.1", assistant: true });
  assert.equal((await currentConversation(ids.agent))?.kind, "slack");
  await send(hub, message(OWNER_TG, "Switching to Telegram"));
  assert.equal((await currentConversation(ids.agent))?.kind, "telegram");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await setThread(ids.agent, { channel: "D123", threadTs: "1.2", assistant: true });
  assert.equal((await currentConversation(ids.agent))?.kind, "slack");
  const { clearRoute } = await import("../store");
  await clearRoute(ids.agent);
  const { getDb, schema } = await import("@/lib/db");
  await getDb().delete(schema.slackThreads).where(eq(schema.slackThreads.agentId, ids.agent));
  assert.equal(await currentConversation(ids.agent), null);
});

test("a reply goes to the conversation its turn came from, never to whoever spoke last", { skip }, async () => {
  const { hub, ws } = await connected();
  await pair(hub);
  const { setChannelSenders } = await import("../settings");
  await setChannelSenders(ids.agent, "telegram", "sam_example");
  assert.equal(await send(hub, message(STRANGER_TG, "hi there")), "delivered");
  const outside = (ws.received.filter((m) => m.type === "chat").at(-1) as { origin?: string }).origin;
  assert.ok(outside);
  const { activeRoute } = await import("../store");
  assert.equal(await activeRoute(ids.agent), null);
  const { computerHandlers } = await import("../../hub/computer-handlers");
  calls.length = 0;
  await computerHandlers.turn(hub, ids.agent, { type: "turn" } as never);
  await computerHandlers.chat(hub, ids.agent, { type: "chat", role: "understudy", text: "The owner's private answer." } as never);
  const { queueReplyFile } = await import("../relay");
  assert.equal(await queueReplyFile(ids.agent, { path: "outbox/private.pdf", name: "private.pdf", size: 10, mime: "application/pdf" }), false);
  await computerHandlers.state(hub, ids.agent, { type: "state", state: "calm" } as never);
  await computerHandlers.turn(hub, ids.agent, { type: "turn", origin: outside } as never);
  await computerHandlers.chat(hub, ids.agent, { type: "chat", role: "understudy", text: "Hello Sam." } as never);
  await computerHandlers.state(hub, ids.agent, { type: "state", state: "calm" } as never);
  await settle(100);
  const texts = calls.filter((call) => call.method === "sendMessage").map((call) => [call.body.chat_id, call.body.text]);
  assert.deepEqual(texts, [[String(STRANGER_TG), "Hello Sam."]]);
  assert.equal(await activeRoute(ids.agent), null);
  await send(hub, message(OWNER_TG, "Back to me"));
  assert.ok(await activeRoute(ids.agent));
});

test("a listed username is pinned to the first account that uses it", { skip }, async () => {
  const { hub } = await connected();
  await pair(hub);
  const { setChannelSenders, channelSettings } = await import("../settings");
  await setChannelSenders(ids.agent, "telegram", "sam_example, 333333");
  assert.equal(await send(hub, message(STRANGER_TG, "first contact")), "delivered");
  assert.equal((await channelSettings(ids.agent)).telegram.senders, `${STRANGER_TG}, 333333`);
  const impostor = { update_id: updateId++, message: { message_id: updateId, from: { id: 444444, first_name: "Other", username: "sam_example" }, chat: { id: 444444, type: "private" }, text: "it's me" } };
  assert.equal(await send(hub, impostor), "held");
});

test("a used or replaced link code never works again, even after changing the bot", { skip }, async () => {
  const { hub } = await connected();
  const { channelSettings } = await import("../settings");
  const first = new URL((await channelSettings(ids.agent)).telegram.pairLink as string).searchParams.get("start") as string;
  botId = 123123123;
  const { connectTelegram } = await import("./connect");
  assert.equal((await connectTelegram(ids.agent, TOKEN)).ok, true);
  const second = new URL((await channelSettings(ids.agent)).telegram.pairLink as string).searchParams.get("start") as string;
  assert.notEqual(first, second);
  assert.notEqual(await send(hub, message(OWNER_TG, `/start ${first}`)), "paired");
  assert.equal(await send(hub, message(OWNER_TG, `/start ${second}`)), "paired");
});
