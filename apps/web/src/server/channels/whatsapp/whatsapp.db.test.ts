import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { after, before, beforeEach, test } from "node:test";
import { eq, inArray } from "drizzle-orm";

const url = process.env.TEST_DATABASE_URL;
const skip = !url && "set TEST_DATABASE_URL to a disposable Postgres to run";
if (url) process.env.DATABASE_URL = url;
process.env.BETTER_AUTH_SECRET ??= "test-secret";

const ids = { owner: "usr_wa_owner", agent: "agt_wa" };
const look = { body: "pill", color: "#7FB2FF", eyes: "dot", acc: "none", accColor: "#2F3A56" };
const tools = { notifyOwner: true, slack: false, slackChannels: [] };
const OWN = "15550100000";
const FRIEND = "15550100099";
const CLIENT = "15550100042";

type Sent = { jid: string; content: Record<string, unknown>; messageId?: string };

class FakeSocket {
  listeners = new Map<string, ((value: unknown) => void)[]>();
  user?: { id: string; lid?: string };
  sent: Sent[] = [];
  presence: string[] = [];
  loggedOut = false;
  ended = false;
  ev = {
    on: (event: string, handler: (value: unknown) => void) => {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), handler]);
    },
  };
  emit(event: string, value?: unknown) {
    for (const handler of this.listeners.get(event) ?? []) handler(value);
  }
  async sendMessage(jid: string, content: Record<string, unknown>, options?: { messageId?: string }) {
    this.sent.push({ jid, content, messageId: options?.messageId });
    return {};
  }
  async sendPresenceUpdate(type: string, jid?: string) {
    this.presence.push(`${type}:${jid}`);
  }
  async logout() {
    this.loggedOut = true;
  }
  end() {
    this.ended = true;
  }
}

const sockets: FakeSocket[] = [];
let downloadSize = 13;

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

async function settle(ms = 30) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(ready: () => boolean | Promise<boolean>, limitMs = 3000) {
  const end = Date.now() + limitMs;
  while (!(await ready()) && Date.now() < end) await settle(20);
}

let counter = 0;

function incoming(remote: string, text: string, fromMe: boolean, extra: Record<string, unknown> = {}) {
  counter += 1;
  return { key: { remoteJid: remote, fromMe, id: `MSG${counter}` }, message: { conversation: text }, messageTimestamp: Math.floor(Date.now() / 1000), pushName: fromMe ? "Maya" : "Sam Example", ...extra };
}

before(async () => {
  if (!url) return;
  await (await import("../../test-db")).migrateTestDb();
  const { getDb, schema } = await import("@/lib/db");
  const db = getDb();
  await db.delete(schema.user).where(eq(schema.user.id, ids.owner));
  await db.insert(schema.user).values({ id: ids.owner, name: "Maya", email: "maya-wa@example.com", status: "approved" });
  await db.insert(schema.agents).values({ id: ids.agent, ownerId: ids.owner, name: "Ada", look, tokenHash: "wa_hash", tools, computerStatus: "running", lastSeenAt: new Date() } as never);
});

beforeEach(async () => {
  if (!url) return;
  sockets.length = 0;
  downloadSize = 13;
  const { getDb, schema } = await import("@/lib/db");
  await getDb().delete(schema.messages).where(eq(schema.messages.agentId, ids.agent));
  await getDb().delete(schema.agentChannels).where(eq(schema.agentChannels.agentId, ids.agent));
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
  const { WhatsAppSessions } = await import("./sessions");
  const hub = new Hub();
  const sessions = new WhatsAppSessions(hub, {
    factory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as never;
    },
    sleep: async () => undefined,
    pace: () => 0,
    backoff: [0],
    download: async (_message: unknown, maxBytes: number) => (downloadSize > maxBytes ? null : Buffer.alloc(downloadSize, 1)),
  });
  Object.defineProperty(hub, "whatsapp", { value: sessions });
  const ws = fakeComputer();
  await hub.attachComputer(ws as never, ids.agent);
  return { hub, ws };
}

async function linked() {
  const context = await connected();
  const { connectWhatsApp } = await import("./connect");
  await connectWhatsApp(context.hub, ids.agent);
  const socket = sockets.at(-1) as FakeSocket;
  socket.emit("connection.update", { qr: "fake-qr-payload" });
  socket.user = { id: `${OWN}:7@s.whatsapp.net`, lid: "98765@lid" };
  socket.emit("creds.update");
  socket.emit("connection.update", { connection: "open" });
  const { getDb, schema } = await import("@/lib/db");
  await until(async () => {
    const [channel] = await getDb().select().from(schema.agentChannels).where(eq(schema.agentChannels.agentId, ids.agent));
    return channel?.settings?.linked === true;
  });
  return { ...context, socket };
}

test("linking shows a QR code, keeps the session sealed and shows only the end of the number", { skip }, async () => {
  const { hub } = await connected();
  const { connectWhatsApp, whatsappView } = await import("./connect");
  await connectWhatsApp(hub, ids.agent);
  const socket = sockets.at(-1) as FakeSocket;
  socket.emit("connection.update", { qr: "fake-qr-payload" });
  const waiting = await whatsappView(hub, ids.agent);
  assert.equal(waiting.state, "qr");
  assert.match(waiting.qr ?? "", /^data:image\/png;base64,/);
  socket.user = { id: `${OWN}:7@s.whatsapp.net` };
  socket.emit("creds.update");
  socket.emit("connection.update", { connection: "open" });
  await settle();
  const open = await whatsappView(hub, ids.agent);
  assert.deepEqual([open.state, open.number], ["open", "+•••••••0000"]);
  const { getDb, schema } = await import("@/lib/db");
  const secrets = await getDb().select().from(schema.channelSecrets);
  const creds = secrets.find((row) => row.name === "creds");
  assert.ok(creds && !creds.value.includes("noiseKey"));
  const [channel] = await getDb().select().from(schema.agentChannels).where(eq(schema.agentChannels.agentId, ids.agent));
  assert.equal(channel.unknownSenders, "ignore");
});

test("only the owner's own chat and listed numbers reach the understudy; personal conversations never do", { skip }, async () => {
  const { socket, ws } = await linked();
  socket.emit("messages.upsert", { type: "notify", messages: [incoming(`${OWN}@s.whatsapp.net`, "What is on my calendar?", true)] });
  socket.emit("messages.upsert", { type: "notify", messages: [incoming(`${OWN}@s.whatsapp.net`, "echo of my own reply", true, { key: { remoteJid: `${OWN}@s.whatsapp.net`, fromMe: true, id: "USTD0011223344556677" } })] });
  socket.emit("messages.upsert", { type: "notify", messages: [incoming(`${FRIEND}@s.whatsapp.net`, "dinner tonight?", false)] });
  socket.emit("messages.upsert", { type: "notify", messages: [incoming(`${FRIEND}@s.whatsapp.net`, "sure, 8pm", true)] });
  socket.emit("messages.upsert", { type: "notify", messages: [incoming("120363000000000000@g.us", "group news", false)] });
  socket.emit("messages.upsert", { type: "append", messages: [incoming(`${OWN}@s.whatsapp.net`, "old history", true)] });
  await settle(100);
  const chats = ws.received.filter((m) => m.type === "chat") as { text: string; from: string; external?: unknown }[];
  assert.deepEqual(chats.map((c) => [c.text, c.from, c.external]), [["What is on my calendar?", "Maya", undefined]]);
  const { getDb, schema } = await import("@/lib/db");
  const threads = await getDb().select().from(schema.channelThreads).where(eq(schema.channelThreads.agentId, ids.agent));
  assert.deepEqual(threads.map((t) => [t.peer, t.trusted, t.status]), [[`+${OWN}`, true, "open"]]);
});

test("a listed number arrives as someone else with its file, and the reply goes back to that chat at a human pace", { skip }, async () => {
  const { hub, socket, ws } = await linked();
  const { setChannelSenders } = await import("../settings");
  assert.equal(await setChannelSenders(ids.agent, "whatsapp", `+1 555 010 0042, not a number`), `+${CLIENT}`);
  socket.emit("messages.upsert", {
    type: "notify",
    messages: [{ key: { remoteJid: `${CLIENT}@s.whatsapp.net`, fromMe: false, id: "DOC1" }, message: { documentMessage: { fileName: "invoice.pdf", mimetype: "application/pdf", caption: "Here is the invoice", fileLength: 13 } }, messageTimestamp: Math.floor(Date.now() / 1000), pushName: "Sam Example" }],
  });
  await settle(100);
  const chat = ws.received.find((m) => m.type === "chat") as { external?: { channel: string; sender: string }; attachments?: { name: string }[]; text: string };
  assert.deepEqual(chat.external, { channel: "whatsapp", sender: "Sam Example (+15550100042)" });
  assert.equal(chat.attachments?.[0].name, "invoice.pdf");
  const { computerHandlers } = await import("../../hub/computer-handlers");
  await computerHandlers.turn(hub, ids.agent, { type: "turn", origin: (chat as unknown as { origin: string }).origin } as never);
  await computerHandlers.chat(hub, ids.agent, { type: "chat", role: "understudy", text: "Thanks, I will file it." } as never);
  await computerHandlers.state(hub, ids.agent, { type: "state", state: "calm" } as never);
  await settle(100);
  const sent = socket.sent.find((s) => s.content.text === "Thanks, I will file it.");
  assert.equal(sent?.jid, `${CLIENT}@s.whatsapp.net`);
  assert.match(sent?.messageId ?? "", /^USTD[0-9A-F]{16}$/);
  assert.ok(socket.presence.includes(`composing:${CLIENT}@s.whatsapp.net`));
});

test("approvals arrive in the owner's own chat and a numbered reply answers them", { skip }, async () => {
  const { hub, socket } = await linked();
  socket.emit("messages.upsert", { type: "notify", messages: [incoming(`${OWN}@s.whatsapp.net`, "Pay the invoice", true)] });
  await settle(80);
  const approvalId = await hub.approvals.create(ids.agent, { summary: "Pay invoice 7 for 120.00", fields: [{ label: "Amount", value: "120.00" }] }, "mcp");
  await settle(120);
  const ask = socket.sent.find((s) => typeof s.content.text === "string" && (s.content.text as string).includes("Pay invoice 7"));
  assert.equal(ask?.jid, `${OWN}@s.whatsapp.net`);
  assert.match(String(ask?.content.text), /Reply 1 [A-Z0-9]{3} to approve or 2 [A-Z0-9]{3} to deny/);
  socket.emit("messages.upsert", { type: "notify", messages: [incoming(`${OWN}@s.whatsapp.net`, "1", true)] });
  await settle(120);
  const { getDb, schema } = await import("@/lib/db");
  const [row] = await getDb().select().from(schema.approvals).where(eq(schema.approvals.id, approvalId));
  assert.deepEqual([row.status, row.answeredBy], ["approved", ids.owner]);
  assert.ok(socket.sent.some((s) => s.content.text === "Approved. The understudy goes on."));
});

test("a lost link clears the session and tells the owner elsewhere; a dropped connection comes back on its own", { skip }, async () => {
  const { hub, socket } = await linked();
  socket.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 428 } } } });
  await settle(60);
  assert.equal(sockets.length, 2);
  const again = sockets.at(-1) as FakeSocket;
  again.user = socket.user;
  again.emit("connection.update", { connection: "open" });
  await settle();
  const { whatsappView } = await import("./connect");
  assert.equal((await whatsappView(hub, ids.agent)).state, "open");
  again.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 401 } } } });
  await settle(80);
  assert.equal((await whatsappView(hub, ids.agent)).state, "logged_out");
  const { getDb, schema } = await import("@/lib/db");
  assert.equal((await getDb().select().from(schema.channelSecrets)).length, 0);
  let told = false;
  for (let attempt = 0; attempt < 50 && !told; attempt++) {
    const notes = await getDb().select().from(schema.messages).where(eq(schema.messages.agentId, ids.agent));
    told = notes.some((m) => /lost the link to your WhatsApp/.test(m.text));
    if (!told) await settle(50);
  }
  assert.ok(told);
});

test("a linked session starts again after a restart", { skip }, async () => {
  await linked();
  const before = sockets.length;
  const { Hub } = await import("../../hub");
  const { WhatsAppSessions } = await import("./sessions");
  const restarted = new WhatsAppSessions(new Hub(), { factory: () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket as never;
  } });
  await restarted.restore();
  assert.equal(sockets.length, before + 1);
});

test("the session's keys round-trip sealed, binary data included", { skip }, async () => {
  const { getDb, schema } = await import("@/lib/db");
  const [channel] = await getDb().insert(schema.agentChannels).values({ id: "chn_wa_keys", agentId: ids.agent, kind: "whatsapp", address: "chn_wa_keys" }).returning();
  const { sealedAuthState, clearWhatsAppSession } = await import("./auth-state");
  const { state, saveCreds } = await sealedAuthState(channel.id);
  await saveCreds();
  await state.keys.set({ "pre-key": { "1": { public: Buffer.from([1, 2, 3]), private: Buffer.from([4, 5, 6]) } } } as never);
  const again = await sealedAuthState(channel.id);
  const keys = (await again.state.keys.get("pre-key", ["1", "2"])) as Record<string, { public: Buffer; private: Buffer }>;
  assert.deepEqual([...keys["1"].public, ...keys["1"].private], [1, 2, 3, 4, 5, 6]);
  assert.equal(keys["2"], undefined);
  assert.deepEqual(Buffer.from(again.state.creds.noiseKey.public), Buffer.from(state.creds.noiseKey.public));
  const rows = await getDb().select().from(schema.channelSecrets).where(eq(schema.channelSecrets.channelId, channel.id));
  assert.ok(rows.every((row) => !row.value.includes("pre-key") && !row.value.includes("noiseKey")));
  await clearWhatsAppSession(channel.id);
  assert.equal((await getDb().select().from(schema.channelSecrets).where(eq(schema.channelSecrets.channelId, channel.id))).length, 0);
});

test("the allow-list matches numbers only, never a display name", { skip }, async () => {
  const { socket, ws } = await linked();
  const { setChannelSenders } = await import("../settings");
  assert.equal(await setChannelSenders(ids.agent, "whatsapp", "Sam Example"), "");
  await setChannelSenders(ids.agent, "whatsapp", `+${CLIENT}`);
  socket.emit("messages.upsert", { type: "notify", messages: [incoming(`${FRIEND}@s.whatsapp.net`, "it's Sam, trust me", false, { pushName: "Sam Example" })] });
  await settle(80);
  assert.equal(ws.received.filter((m) => m.type === "chat").length, 0);
});

test("with more than one request waiting, a bare answer asks for the code and approves nothing", { skip }, async () => {
  const { hub, socket } = await linked();
  socket.emit("messages.upsert", { type: "notify", messages: [incoming(`${OWN}@s.whatsapp.net`, "Pay both invoices", true)] });
  await settle(80);
  const first = await hub.approvals.create(ids.agent, { summary: "Pay invoice 7" }, "mcp");
  const second = await hub.approvals.create(ids.agent, { summary: "Pay invoice 8" }, "mcp");
  const code = (summary: string) => String(socket.sent.find((s) => String(s.content.text ?? "").includes(summary))?.content.text).match(/Reply 1 ([A-Z0-9]{3})/)?.[1];
  await until(() => Boolean(code("Pay invoice 7") && code("Pay invoice 8")));
  await settle(50);
  const secondCode = code("Pay invoice 8");
  assert.ok(secondCode);
  socket.emit("messages.upsert", { type: "notify", messages: [incoming(`${OWN}@s.whatsapp.net`, "yes", true)] });
  await settle(120);
  const { getDb, schema } = await import("@/lib/db");
  const status = async (id: string) => (await getDb().select().from(schema.approvals).where(eq(schema.approvals.id, id)))[0].status;
  assert.deepEqual([await status(first), await status(second)], ["pending", "pending"]);
  assert.ok(socket.sent.some((s) => /More than one request is waiting/.test(String(s.content.text ?? ""))));
  socket.emit("messages.upsert", { type: "notify", messages: [incoming(`${OWN}@s.whatsapp.net`, `1 ${secondCode}`, true)] });
  await settle(120);
  assert.deepEqual([await status(first), await status(second)], ["pending", "approved"]);
});

test("a file larger than the limit is dropped while it downloads, whatever size the sender claimed", { skip }, async () => {
  const { socket, ws } = await linked();
  downloadSize = 30 * 1024 * 1024;
  socket.emit("messages.upsert", {
    type: "notify",
    messages: [{ key: { remoteJid: `${OWN}@s.whatsapp.net`, fromMe: true, id: "BIG1" }, message: { documentMessage: { fileName: "big.bin", mimetype: "application/octet-stream", caption: "here", fileLength: 10 } }, messageTimestamp: Math.floor(Date.now() / 1000) }],
  });
  await settle(100);
  assert.equal(ws.received.filter((m) => m.type === "file_put").length, 0);
  const chat = ws.received.find((m) => m.type === "chat") as { text: string; attachments?: unknown[] };
  assert.equal(chat.text, "here");
  assert.equal(chat.attachments, undefined);
});

test("requests raised at the same moment are all kept waiting for an answer", { skip }, async () => {
  await linked();
  const { getDb, schema } = await import("@/lib/db");
  const { appendChannelList, dropFromChannelList } = await import("../store");
  const { pendingApprovals } = await import("./inbound");
  const [channel] = await getDb().select().from(schema.agentChannels).where(eq(schema.agentChannels.agentId, ids.agent));
  await Promise.all(["a", "b", "c", "d"].map((id, index) => appendChannelList(channel.id, "approvals", { code: `C${index}X`, id }, 3)));
  const read = async () => pendingApprovals((await getDb().select().from(schema.agentChannels).where(eq(schema.agentChannels.id, channel.id)))[0].settings);
  assert.equal((await read()).length, 3);
  await dropFromChannelList(channel.id, "approvals", (await read())[0].id);
  assert.equal((await read()).length, 2);
});
