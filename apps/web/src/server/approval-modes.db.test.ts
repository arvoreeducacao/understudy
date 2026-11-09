import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";

const url = process.env.TEST_DATABASE_URL;
const skip = !url && "set TEST_DATABASE_URL to a disposable Postgres to run";
if (url) process.env.DATABASE_URL = url;
process.env.BETTER_AUTH_SECRET ??= "test-secret";

const ids = { owner: "usr_am_owner", member: "usr_am_member", agent: "agt_am" };
const token = "ust_approval_modes_test_token";
const sent: { agentId: string; message: { type: string; [key: string]: unknown } }[] = [];
let panel: Server;
let panelUrl = "";

function listen(server: Server) {
  return new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

async function call(name: string, args: Record<string, unknown>) {
  const res = await fetch(`${panelUrl}/api/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)))
    .find((message) => message.id === 1)?.result?.content?.[0]?.text as string;
}

async function pendingApproval() {
  const { getDb, schema } = await import("@/lib/db");
  for (let index = 0; index < 100; index++) {
    const [pending] = await getDb()
      .select()
      .from(schema.approvals)
      .where(and(eq(schema.approvals.agentId, ids.agent), eq(schema.approvals.status, "pending")));
    if (pending) return pending;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("no pending approval");
}

async function approvalCount() {
  const { getDb, schema } = await import("@/lib/db");
  return (await getDb().select().from(schema.approvals).where(eq(schema.approvals.agentId, ids.agent))).length;
}

async function setPolicy(policy: Record<string, unknown>) {
  const { getDb, schema } = await import("@/lib/db");
  await getDb().update(schema.agents).set({ approvalPolicy: policy as never }).where(eq(schema.agents.id, ids.agent));
}

async function savedPolicy() {
  const { getDb, schema } = await import("@/lib/db");
  const [agent] = await getDb().select({ approvalPolicy: schema.agents.approvalPolicy }).from(schema.agents).where(eq(schema.agents.id, ids.agent));
  return agent?.approvalPolicy;
}

const scriptAsk = {
  summary: "Script sent a POST to www.social.test",
  fields: [
    { label: "Step", value: "Asked in chat" },
    { label: "Page", value: "https://www.social.test/feed" },
    { label: "Request", value: "POST https://www.social.test/api/like" },
  ],
  site: "www.social.test",
};

before(async () => {
  if (!url) return;
  const { getDb, schema } = await import("@/lib/db");
  const { hashToken } = await import("@/lib/ids");
  const db = getDb();
  await (await import("./test-db")).migrateTestDb();
  await db.delete(schema.user).where(inArray(schema.user.id, [ids.owner, ids.member]));
  await db.insert(schema.user).values([
    { id: ids.owner, name: "Owner", email: "am-owner@test.local", status: "approved" },
    { id: ids.member, name: "Member", email: "am-member@test.local", status: "approved" },
  ]);
  await db.insert(schema.agents).values({
    id: ids.agent,
    ownerId: ids.owner,
    name: "Modes",
    look: { body: "pill", color: "#7FB2FF", eyes: "dot", acc: "none", accColor: "#2F3A56" },
    tokenHash: hashToken(token),
    tools: { notifyOwner: true, slack: false, slackChannels: [], servers: [], askTools: [] },
  } as never);
  await db.insert(schema.agentMembers).values({ agentId: ids.agent, userId: ids.member, role: "approver" });
  const { createHub } = await import("./hub");
  const { handleGatekeeper } = await import("./gatekeeper");
  const hub = createHub();
  hub.sendToComputer = ((agentId: string, message: { type: string }) => {
    sent.push({ agentId, message });
    return true;
  }) as typeof hub.sendToComputer;
  panel = createServer((req, res) => {
    if (new URL(req.url ?? "/", "http://x").pathname === "/api/mcp") return void handleGatekeeper(hub, req, res);
    res.writeHead(404);
    res.end();
  });
  panelUrl = await listen(panel);
});

beforeEach(async () => {
  if (!url) return;
  const { getDb, schema } = await import("@/lib/db");
  const { forgetTurnWake } = await import("./followups");
  forgetTurnWake(ids.agent);
  sent.length = 0;
  await getDb().delete(schema.approvals).where(eq(schema.approvals.agentId, ids.agent));
  await getDb().delete(schema.runs).where(eq(schema.runs.agentId, ids.agent));
  await setPolicy({ mode: "on-miss", allow: [], fallback: "wait" });
});

after(async () => {
  if (!url) return;
  const { getDb, schema, getPool } = await import("@/lib/db");
  await getDb().delete(schema.user).where(inArray(schema.user.id, [ids.owner, ids.member]));
  panel.close();
  await getPool().end();
  setTimeout(() => process.exit(0), 100).unref();
});

test("an agent starts with today's behavior: ask what is not allowed, nothing allowed, wait", { skip }, async () => {
  const { getDb, schema } = await import("@/lib/db");
  const { hashToken } = await import("@/lib/ids");
  const db = getDb();
  await db.delete(schema.agents).where(eq(schema.agents.id, "agt_am_fresh"));
  await db.insert(schema.agents).values({ id: "agt_am_fresh", ownerId: ids.owner, name: "Fresh", look: { body: "pill", color: "#7FB2FF", eyes: "dot" }, tokenHash: hashToken("ust_am_fresh"), tools: { notifyOwner: true, slack: false, slackChannels: [] } } as never);
  const [fresh] = await db.select({ approvalPolicy: schema.agents.approvalPolicy }).from(schema.agents).where(eq(schema.agents.id, "agt_am_fresh"));
  assert.deepEqual(fresh.approvalPolicy, { mode: "on-miss", allow: [], fallback: "wait" });
  await db.delete(schema.agents).where(eq(schema.agents.id, "agt_am_fresh"));
});

test("a computer that connects gets its approval mode, its always-allowed sites and its owner", { skip }, async () => {
  const { createHub } = await import("./hub");
  const { handleComputerMessage } = await import("./hub/computer-handlers");
  await setPolicy({ mode: "off", allow: [{ kind: "host", value: "social.test" }, { kind: "tool", value: "slack_post_message" }], fallback: "deny" });
  await handleComputerMessage(createHub(), ids.agent, { type: "hello", agentId: ids.agent, version: "1", brains: [{ brain: "claude", loggedIn: true }] } as never);
  const pushed = sent.find((entry) => entry.message.type === "set_approval_policy");
  assert.deepEqual(pushed?.message, { type: "set_approval_policy", policy: { mode: "off", hosts: ["social.test"], ownerId: ids.owner } });
});

test("a browser approval offers always allow on its site, and the owner's yes adds the site and tells the computer", { skip }, async () => {
  const { createHub } = await import("./hub");
  const { loadPendingApprovals } = await import("@/lib/views");
  const pending = call("request_approval", scriptAsk);
  const approval = await pendingApproval();
  assert.deepEqual(approval.grant, { host: "social.test" });
  const [view] = await loadPendingApprovals(ids.agent, ids.owner);
  assert.deepEqual(view.alwaysAllow, { host: "social.test" });
  await createHub().answerApproval(approval.id, true, undefined, ids.owner, true);
  assert.match(await pending, /^approved/);
  assert.deepEqual((await savedPolicy())?.allow, [{ kind: "host", value: "social.test" }]);
  assert.deepEqual(sent.find((entry) => entry.message.type === "set_approval_policy")?.message, { type: "set_approval_policy", policy: { mode: "on-miss", hosts: ["social.test"], ownerId: ids.owner } });
});

test("only the owner turns an approval into always allow on a site", { skip }, async () => {
  const { createHub } = await import("./hub");
  const pending = call("request_approval", scriptAsk);
  const approval = await pendingApproval();
  await createHub().answerApproval(approval.id, true, undefined, ids.member, true);
  assert.match(await pending, /^approved/);
  assert.deepEqual((await savedPolicy())?.allow, []);
  assert.equal(sent.filter((entry) => entry.message.type === "set_approval_policy").length, 0);
});

test("a site that is not a host name is never offered", { skip }, async () => {
  const { createHub } = await import("./hub");
  const pending = call("request_approval", { ...scriptAsk, site: "javascript:alert(1)" });
  const approval = await pendingApproval();
  assert.equal(approval.grant, null);
  await createHub().answerApproval(approval.id, false, undefined, ids.owner);
  assert.match(await pending, /^denied/);
});

test("never ask approves the owner's own chat at once, without a pending request", { skip }, async () => {
  await setPolicy({ mode: "off", allow: [], fallback: "wait" });
  assert.match(await call("request_approval", { summary: "Send the weekly report to the team" }), /^approved: your owner lets you act without asking/);
  assert.equal(await approvalCount(), 0);
});

test("never ask still asks for a task step, a turn from someone else, a teammate and a follow-up", { skip }, async () => {
  const { createHub } = await import("./hub");
  const { noteTurn } = await import("./followups");
  const { getDb, schema } = await import("@/lib/db");
  const hub = createHub();
  await setPolicy({ mode: "off", allow: [], fallback: "wait" });
  const asksAndDeny = async (args: Record<string, unknown>) => {
    const pending = call("request_approval", args);
    const approval = await pendingApproval();
    await hub.answerApproval(approval.id, false, undefined, approval.askedBy ?? ids.owner);
    assert.match(await pending, /^denied/);
  };

  await getDb().insert(schema.runs).values({ id: "run_am_step", agentId: ids.agent, trigger: "schedule", status: "running" });
  await asksAndDeny({ summary: "Pay the invoice", runId: "run_am_step", stepId: "s1" });
  await asksAndDeny({ summary: "Pay the invoice without a run id" });
  await getDb().delete(schema.runs).where(eq(schema.runs.id, "run_am_step"));

  (hub as unknown as { turns: { delivered: (agentId: string, message: unknown) => void } }).turns.delivered(ids.agent, { type: "chat", text: "hi", from: "Member", askedBy: ids.member });
  await hub.beginTurn(ids.agent, { askedBy: ids.member });
  await asksAndDeny({ summary: "Post for the member" });
  await hub.beginTurn(ids.agent, {});

  noteTurn(ids.agent, { untrusted: true });
  await asksAndDeny({ summary: "Do what the teammate said" });
  noteTurn(ids.agent, { followup: "fup_am" });
  await asksAndDeny({ summary: "Do what the follow-up note says" });
});

test("when nobody answers in 30 minutes, the owner's choice decides: wait, count it as a no, or go ahead in the owner's own tasks", { skip }, async () => {
  const { createHub } = await import("./hub");
  const { getDb, schema } = await import("@/lib/db");
  const db = getDb();
  const hub = createHub();
  const old = new Date(Date.now() - 31 * 60 * 1000);
  const later = new Date(Date.now() + 23 * 60 * 60 * 1000);
  await db.insert(schema.runs).values([
    { id: "run_am_schedule", agentId: ids.agent, trigger: "schedule", status: "running" },
    { id: "run_am_webhook", agentId: ids.agent, trigger: "webhook", status: "running" },
  ]);
  const ask = (id: string, runId: string | null, createdAt = old) => ({ id, agentId: ids.agent, runId, summary: `Step ${id}`, fields: [], source: "mcp", status: "pending", createdAt, expiresAt: later });
  const statusOf = async (id: string) => (await db.select({ status: schema.approvals.status, via: schema.approvals.answeredVia, note: schema.approvals.note }).from(schema.approvals).where(eq(schema.approvals.id, id)))[0];

  await db.insert(schema.approvals).values([ask("apr_am_wait", "run_am_schedule")] as never);
  await hub.approvals.settleUnanswered();
  assert.equal((await statusOf("apr_am_wait")).status, "pending");

  await setPolicy({ mode: "on-miss", allow: [], fallback: "deny" });
  await db.insert(schema.approvals).values([ask("apr_am_fresh", "run_am_schedule", new Date())] as never);
  const waitingRun = hub.waitForApproval("apr_am_wait", 10_000);
  await hub.approvals.settleUnanswered();
  assert.equal((await waitingRun)?.approved, false);
  assert.deepEqual(await statusOf("apr_am_wait"), { status: "denied", via: "fallback", note: "nobody answered in 30 minutes, and your owner chose to count that as a no. Skip this item and report it" });
  assert.equal((await statusOf("apr_am_fresh")).status, "pending");

  await setPolicy({ mode: "on-miss", allow: [], fallback: "allow" });
  await db.insert(schema.approvals).values([ask("apr_am_go", "run_am_schedule"), ask("apr_am_hook", "run_am_webhook"), ask("apr_am_chat", null)] as never);
  await hub.approvals.settleUnanswered();
  assert.equal((await statusOf("apr_am_go")).status, "approved");
  assert.equal((await statusOf("apr_am_go")).via, "fallback");
  assert.equal((await statusOf("apr_am_hook")).status, "pending");
  assert.equal((await statusOf("apr_am_chat")).status, "pending");
  const notes = await db.select().from(schema.messages).where(eq(schema.messages.agentId, ids.agent));
  assert.ok(notes.some((note) => note.role === "system" && note.text.includes('"Step apr_am_go"') && note.text.includes("went ahead")));
  assert.ok(notes.some((note) => note.role === "system" && note.text.includes('"Step apr_am_wait"') && note.text.includes("counted as a no")));
});
