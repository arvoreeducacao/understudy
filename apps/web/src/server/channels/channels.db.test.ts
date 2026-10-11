import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { after, before, beforeEach, test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";

const url = process.env.TEST_DATABASE_URL;
const skip = !url && "set TEST_DATABASE_URL to a disposable Postgres to run";
if (url) process.env.DATABASE_URL = url;
process.env.BETTER_AUTH_SECRET ??= "test-secret";
process.env.UNDERSTUDY_INBOUND_EMAIL_DOMAIN = "mail.example.com";
process.env.UNDERSTUDY_OUTBOUND_EMAIL = "smtp://localhost:2525";

const ids = { owner: "usr_ch_owner", agent: "agt_ch" };
const look = { body: "pill", color: "#7FB2FF", eyes: "dot", acc: "none", accColor: "#2F3A56" };
const tools = { notifyOwner: true, slack: false, slackChannels: [] };
const OWNER = "maya@example.com";

type Sent = { raw: Buffer; envelope: { from: string; to: string[] } };
const outbox: Sent[] = [];

function fakeComputer(files: Record<string, Buffer> = {}) {
  const ws = Object.assign(new EventEmitter(), {
    OPEN: 1,
    readyState: 1,
    received: [] as Record<string, unknown>[],
    send(raw: string) {
      const message = JSON.parse(raw);
      ws.received.push(message);
      if (message.type === "file_read") {
        const data = files[message.path];
        const reply = data
          ? { type: "file_chunk", requestId: message.requestId, size: data.length, base64: data.subarray(message.offset, message.offset + (message.length || data.length)).toString("base64") }
          : { type: "file_chunk", requestId: message.requestId, error: "missing" };
        setImmediate(() => ws.emit("message", Buffer.from(JSON.stringify(reply))));
      }
    },
    ping() {},
    close() {
      ws.readyState = 3;
      ws.emit("close");
    },
  });
  return ws;
}

function mail(lines: Record<string, string>, body: string) {
  return Buffer.from([...Object.entries(lines).map(([key, value]) => `${key}: ${value}`), "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", body, ""].join("\r\n"));
}

async function settle(ms = 30) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

let address = "";

before(async () => {
  if (!url) return;
  await (await import("../test-db")).migrateTestDb();
  const { getDb, schema } = await import("@/lib/db");
  const db = getDb();
  await db.delete(schema.user).where(eq(schema.user.id, ids.owner));
  await db.insert(schema.user).values({ id: ids.owner, name: "Maya", email: OWNER, status: "approved" });
  await db.insert(schema.agents).values({ id: ids.agent, ownerId: ids.owner, name: "Ada", look, tokenHash: "ch_hash", tools, computerStatus: "running", lastSeenAt: new Date() } as never);
  const { registerAdapter } = await import("./relay");
  const { emailAdapter } = await import("./email/adapter");
  registerAdapter(emailAdapter(() => async (raw, envelope) => void outbox.push({ raw, envelope })));
});

beforeEach(async () => {
  if (!url) return;
  outbox.length = 0;
  const { getDb, schema } = await import("@/lib/db");
  await getDb().delete(schema.messages).where(eq(schema.messages.agentId, ids.agent));
  const { disableEmailChannel, enableEmailChannel } = await import("./settings");
  await disableEmailChannel(ids.agent);
  address = await enableEmailChannel(ids.agent, "Ada");
});

after(async () => {
  if (!url) return;
  const { getDb, schema, getPool } = await import("@/lib/db");
  await getDb().delete(schema.user).where(inArray(schema.user.id, [ids.owner]));
  await getPool().end();
  setTimeout(() => process.exit(0), 100).unref();
});

async function connected(files?: Record<string, Buffer>) {
  const { Hub } = await import("../hub");
  const hub = new Hub();
  const ws = fakeComputer(files);
  await hub.attachComputer(ws as never, ids.agent);
  return { hub, ws };
}

async function receive(hub: unknown, raw: Buffer, problem: string | null = null) {
  const { processEmail } = await import("../inbound-email/handler");
  const { inboundConfig } = await import("../inbound-email/config");
  const { channelByAddress } = await import("./store");
  const { findInboundTask } = await import("../inbound-email/lookup");
  return processEmail(hub as never, { config: inboundConfig, findTask: findInboundTask, findChannel: (local) => channelByAddress("email", local), fetchRaw: async () => raw }, raw, [address], problem);
}

test("the owner emails the understudy, it answers in the same thread with the file it shared", { skip }, async () => {
  const { computerHandlers } = await import("../hub/computer-handlers");
  const { queueReplyFile } = await import("./relay");
  const { parseEmail } = await import("../inbound-email/parse");
  const { getDb, schema } = await import("@/lib/db");
  const { hub, ws } = await connected({ "outbox/report.csv": Buffer.from("a,b\n1,2\n") });
  await getDb().insert(schema.slackThreads).values({ agentId: ids.agent, channel: "D1", threadTs: "1.1", assistant: true, expiresAt: new Date(Date.now() + 60_000) }).onConflictDoNothing();

  const outcomes = await receive(hub, mail({ From: `Maya <${OWNER}>`, To: address, Subject: "Weekly numbers", "Message-ID": "<m1@example.com>" }, "Can you send me the weekly numbers?\n\nOn Mon, Oct 5, 2026 at 9:00 AM Ada wrote:\n> old stuff"));
  assert.deepEqual(outcomes.map((o) => o.result), ["delivered"]);
  const chat = ws.received.find((m) => m.type === "chat") as { text: string; from: string; external?: unknown };
  assert.equal(chat.from, "Maya");
  assert.equal(chat.external, undefined);
  assert.equal(chat.text, "Weekly numbers\n\nCan you send me the weekly numbers?");
  const [slack] = await getDb().select().from(schema.slackThreads).where(eq(schema.slackThreads.agentId, ids.agent));
  assert.ok(slack.expiresAt.getTime() <= Date.now());

  await computerHandlers.chat(hub, ids.agent, { type: "chat", role: "understudy", text: "Here they are." } as never);
  await queueReplyFile(ids.agent, { path: "outbox/report.csv", name: "report.csv", size: 8, mime: "text/csv" });
  await computerHandlers.chat(hub, ids.agent, { type: "chat", role: "understudy", text: "Revenue is up." } as never);
  assert.equal(outbox.length, 0);
  await computerHandlers.state(hub, ids.agent, { type: "state", state: "calm" } as never);
  await settle(100);

  assert.equal(outbox.length, 1);
  assert.deepEqual(outbox[0].envelope, { from: address, to: [OWNER] });
  const sent = await parseEmail(outbox[0].raw, 1_000_000);
  assert.equal(sent.subject, "Re: Weekly numbers");
  assert.equal(sent.inReplyTo, "<m1@example.com>");
  assert.deepEqual(sent.references, ["<m1@example.com>"]);
  assert.equal(sent.text, "Here they are.\n\nRevenue is up.");
  assert.equal(sent.automated, true);
  assert.deepEqual(sent.attachments.map((a) => [a.filename, Buffer.from(a.base64, "base64").toString()]), [["report.csv", "a,b\n1,2\n"]]);
  const rows = await getDb().select().from(schema.messages).where(eq(schema.messages.agentId, ids.agent));
  assert.ok(rows.some((r) => r.role === "user" && r.via === "email" && r.authorId === ids.owner));
  assert.ok(rows.some((r) => r.role === "agent" && r.via === "email"));

  const second = await receive(hub, mail({ From: OWNER, To: address, Subject: "Re: Weekly numbers", "Message-ID": "<m2@example.com>", "In-Reply-To": sent.messageId as string, References: `<m1@example.com> ${sent.messageId}` }, "Thanks!"));
  assert.deepEqual(second.map((o) => o.result), ["delivered"]);
  const threads = await getDb().select().from(schema.channelThreads).where(eq(schema.channelThreads.agentId, ids.agent));
  assert.equal(threads.length, 1);
  assert.equal(threads[0].lastMessageId, "<m2@example.com>");
  const last = ws.received.filter((m) => m.type === "chat").at(-1) as { text: string };
  assert.equal(last.text, "Thanks!");
});

test("a panel message takes the conversation back from email", { skip }, async () => {
  const { computerHandlers } = await import("../hub/computer-handlers");
  const { viewerHandlers } = await import("../hub/viewer-handlers");
  const { hub } = await connected();
  await receive(hub, mail({ From: OWNER, To: address, Subject: "Hi", "Message-ID": "<p1@example.com>" }, "Hello"));
  await viewerHandlers.chat({ hub, agentId: ids.agent, userId: ids.owner, refuse: () => undefined } as never, { type: "chat", text: "Actually, answer me here" } as never);
  await computerHandlers.chat(hub, ids.agent, { type: "chat", role: "understudy", text: "Sure." } as never);
  await computerHandlers.state(hub, ids.agent, { type: "state", state: "calm" } as never);
  await settle(50);
  assert.equal(outbox.length, 0);
});

test("an allowed outside sender reaches the understudy as someone else, never as the owner", { skip }, async () => {
  const { setEmailSenders } = await import("./settings");
  await setEmailSenders(ids.agent, "example.org");
  const { hub, ws } = await connected();
  const outcomes = await receive(hub, mail({ From: "Client <buyer@example.org>", To: address, Subject: "Quote", "Message-ID": "<c1@example.org>" }, "Please send me a quote."));
  assert.deepEqual(outcomes.map((o) => o.result), ["delivered"]);
  const chat = ws.received.find((m) => m.type === "chat") as { external?: { channel: string; sender: string }; from: string };
  assert.deepEqual(chat.external, { channel: "email", sender: "buyer@example.org" });
  const { getDb, schema } = await import("@/lib/db");
  const [shown] = await getDb().select().from(schema.messages).where(and(eq(schema.messages.agentId, ids.agent), eq(schema.messages.role, "user")));
  assert.equal(shown.authorId, null);
  assert.match(shown.text, /buyer@example\.org/);
});

test("mail from a stranger is held for the owner and let through only when the owner says so", { skip }, async () => {
  const { channelSettings, releaseHeld } = await import("./settings");
  const { hub, ws } = await connected();
  const outcomes = await receive(hub, mail({ From: "stranger@example.net", To: address, Subject: "Hello", "Message-ID": "<s1@example.net>" }, "Wire me money."));
  assert.deepEqual(outcomes.map((o) => o.result), ["held"]);
  assert.equal(ws.received.filter((m) => m.type === "chat").length, 0);
  const view = await channelSettings(ids.agent);
  assert.equal(view.email.held.length, 1);
  assert.equal(view.email.held[0].peer, "stranger@example.net");
  assert.equal(await releaseHeld(hub, { id: ids.owner, name: "Maya", email: OWNER }, ids.agent, view.email.held[0].id, true), true);
  assert.equal(await releaseHeld(hub, { id: ids.owner, name: "Maya", email: OWNER }, ids.agent, view.email.held[0].id, true), false);
  const chat = ws.received.find((m) => m.type === "chat") as { external?: { sender: string }; text: string };
  assert.equal(chat.external?.sender, "stranger@example.net");
  assert.equal((await channelSettings(ids.agent)).email.senders, "stranger@example.net");
});

test("ignored strangers, automatic mail and unauthenticated mail never reach the understudy", { skip }, async () => {
  const { setUnknownSenders } = await import("./settings");
  const { hub, ws } = await connected();
  const auto = await receive(hub, mail({ From: OWNER, To: address, Subject: "Out of office", "Auto-Submitted": "auto-replied", "Message-ID": "<a1@example.com>" }, "I am away"));
  const spoofed = await receive(hub, mail({ From: OWNER, To: address, Subject: "Pay", "Message-ID": "<x1@example.com>" }, "Pay now"), "sender_not_authenticated");
  await setUnknownSenders(ids.agent, "ignore");
  const stranger = await receive(hub, mail({ From: "stranger@example.net", To: address, Subject: "Hi", "Message-ID": "<s2@example.net>" }, "Hi"));
  assert.deepEqual([auto[0].result, spoofed[0].result, stranger[0].result], ["automated", "sender_not_authenticated", "sender_not_allowed"]);
  assert.equal(ws.received.filter((m) => m.type === "chat").length, 0);
});

test("a rotated address stops working", { skip }, async () => {
  const { enableEmailChannel } = await import("./settings");
  const old = address;
  address = await enableEmailChannel(ids.agent, "Ada");
  assert.notEqual(address, old);
  const { hub } = await connected();
  const { processEmail } = await import("../inbound-email/handler");
  const { inboundConfig } = await import("../inbound-email/config");
  const { channelByAddress } = await import("./store");
  const raw = mail({ From: OWNER, To: old, Subject: "Hi", "Message-ID": "<r1@example.com>" }, "Hi");
  const outcomes = await processEmail(hub as never, { config: inboundConfig, findTask: async () => null, findChannel: (local) => channelByAddress("email", local), fetchRaw: async () => raw }, raw, [old], null);
  assert.deepEqual(outcomes.map((o) => o.result), ["unknown_address"]);
});
