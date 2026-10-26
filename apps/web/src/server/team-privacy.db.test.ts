import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { after, before, test } from "node:test";
import { eq, inArray } from "drizzle-orm";

const url = process.env.TEST_DATABASE_URL;
const skip = !url && "set TEST_DATABASE_URL to a disposable Postgres to run";
if (url) process.env.DATABASE_URL = url;
process.env.BETTER_AUTH_SECRET ??= "test-secret";

const ids = {
  marina: "usr_priv_marina",
  rafael: "usr_priv_rafael",
  tiago: "usr_priv_tiago",
  ledger: "agt_priv_ledger",
  penny: "agt_priv_penny",
  channel: "ach_priv_telegram",
  thread: "cth_priv_marina",
};
const look = { body: "pill", color: "#7FB2FF", eyes: "dot", acc: "none", accColor: "#2F3A56" };
const tools = { notifyOwner: true, slack: false, slackChannels: [] };
let teamId = "";

type Received = { type: string; text?: string; askedBy?: string; followup?: unknown; credentials?: unknown };

function socket() {
  const ws = Object.assign(new EventEmitter(), {
    OPEN: 1,
    readyState: 1,
    received: [] as Received[],
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

async function connectedHub() {
  const { Hub } = await import("./hub");
  const hub = new Hub();
  const computer = socket();
  await hub.attachComputer(computer as never, ids.ledger);
  return { hub, computer };
}

before(async () => {
  if (!url) return;
  await (await import("./test-db")).migrateTestDb();
  const { getDb, schema } = await import("@/lib/db");
  const db = getDb();
  await db.delete(schema.teams).where(eq(schema.teams.createdBy, ids.marina));
  await db.delete(schema.user).where(inArray(schema.user.id, [ids.marina, ids.rafael, ids.tiago]));
  await db.insert(schema.user).values([
    { id: ids.marina, name: "Marina Souza", email: "marina@priv.test", status: "approved" },
    { id: ids.rafael, name: "Rafael Lima", email: "rafael@priv.test", status: "approved" },
    { id: ids.tiago, name: "Tiago Kato", email: "tiago@priv.test", status: "approved" },
  ]);
  await db.insert(schema.agents).values([
    { id: ids.ledger, ownerId: ids.marina, name: "Ledger", look, tokenHash: "hash_priv_ledger", tools, computerStatus: "running", lastSeenAt: new Date() } as never,
    { id: ids.penny, ownerId: ids.tiago, name: "Penny", look, tokenHash: "hash_priv_penny", tools } as never,
  ]);
  const store = await import("./teams-store");
  const created = await store.createTeam(ids.marina, { name: "Finance" });
  teamId = created.ok ? created.id : "";
  await store.addMember(teamId, ids.marina, "rafael@priv.test", "member");
  await store.addMember(teamId, ids.marina, "tiago@priv.test", "member");
  await store.bringAgent(ids.ledger, ids.marina, teamId, true);
  await store.bringAgent(ids.penny, ids.tiago, teamId, false);
  await db.insert(schema.agentChannels).values({ id: ids.channel, agentId: ids.ledger, kind: "telegram", address: "priv-bot" });
  await db.insert(schema.channelThreads).values({ id: ids.thread, agentId: ids.ledger, channelId: ids.channel, peer: "marina-chat", trusted: true });
});

after(async () => {
  if (!url) return;
  const { getDb, schema, getPool } = await import("@/lib/db");
  await getDb().delete(schema.teams).where(eq(schema.teams.createdBy, ids.marina));
  await getDb().delete(schema.user).where(inArray(schema.user.id, [ids.marina, ids.rafael, ids.tiago]));
  await getPool().end();
});

test("the computer cannot pick who a turn is for: a person nobody delivered a message for falls back to the owner", { skip }, async () => {
  const { computerHandlers } = await import("./hub/computer-handlers");
  const { hub } = await connectedHub();
  await hub.deliver(ids.ledger, { type: "chat", text: "north list", from: "Rafael Lima", askedBy: ids.rafael }, { source: "panel" });
  await computerHandlers.turn(hub, ids.ledger, { type: "turn", askedBy: ids.tiago });
  assert.equal(hub.turnAudience(ids.ledger), ids.marina);
  await computerHandlers.turn(hub, ids.ledger, { type: "turn", askedBy: ids.rafael });
  assert.equal(hub.turnAudience(ids.ledger), ids.rafael);
});

test("an approval reaches a group only when it was raised in that group's turn", { skip }, async () => {
  const { getDb, schema } = await import("@/lib/db");
  const { computerHandlers } = await import("./hub/computer-handlers");
  const { createTeamRoom } = await import("./room-store");
  const { hub } = await connectedHub();
  const created = await createTeamRoom(ids.marina, { teamId, name: "october-close", agentIds: [ids.ledger], peopleIds: [ids.rafael] });
  assert.ok(created.ok);
  const roomId = created.ok ? created.id : "";
  await hub.rooms.personSaid(roomId, ids.rafael, "@Ledger send the reminders");
  await hub.deliver(ids.ledger, { type: "chat", text: "my own refund", from: "Rafael Lima", askedBy: ids.rafael }, { source: "panel" });
  await computerHandlers.turn(hub, ids.ledger, { type: "turn", askedBy: ids.rafael });
  const privateOne = await hub.createApproval(ids.ledger, { summary: "Refund 900 to Rafael" }, "mcp", 3600);
  await computerHandlers.turn(hub, ids.ledger, { type: "turn", untrusted: true, askedBy: ids.rafael, roomId });
  const groupOne = await hub.createApproval(ids.ledger, { summary: "Send 3 reminders" }, "mcp", 3600);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const rows = await getDb().select().from(schema.roomMessages).where(eq(schema.roomMessages.roomId, roomId));
  assert.deepEqual(rows.filter((row) => row.approvalId).map((row) => row.approvalId), [groupOne]);
  assert.notEqual(privateOne, groupOne);
  await hub.cancelApprovals(ids.ledger, null);
});

test("the owner's channel conversation with a team understudy stays the owner's, and still replies there", { skip }, async () => {
  const { getDb, schema } = await import("@/lib/db");
  const { loadChat } = await import("@/lib/views");
  const { deliverToAgent } = await import("./channels/deliver");
  const { hub, computer } = await connectedHub();
  const [thread] = await getDb().select().from(schema.channelThreads).where(eq(schema.channelThreads.id, ids.thread));
  await deliverToAgent(hub, { kind: "telegram", agentId: ids.ledger, owner: { id: ids.marina, email: "marina@priv.test", name: "Marina Souza" } as never, thread, trusted: true, text: "salary sheet for March", attachments: [] });
  assert.equal(computer.received.find((m) => m.type === "chat" && m.text === "salary sheet for March")?.askedBy, ids.marina);
  assert.ok((await loadChat(ids.ledger, 50, ids.marina)).some((m) => m.text === "salary sheet for March"));
  assert.ok(!(await loadChat(ids.ledger, 50, ids.rafael)).some((m) => m.text === "salary sheet for March"));
  hub.setTurnAudience(ids.ledger, ids.marina);
  assert.equal(await hub.relaysToChannels(ids.ledger), true);
  hub.setTurnAudience(ids.ledger, ids.rafael);
  assert.equal(await hub.relaysToChannels(ids.ledger), false);
});

test("a member's message does not take over the owner's channel route", { skip }, async () => {
  const { activeRoute, setRoute } = await import("./channels/store");
  const { handleViewerMessage } = await import("./hub/viewer-handlers");
  const { hub } = await connectedHub();
  await setRoute(ids.ledger, ids.thread);
  await handleViewerMessage({ hub, agentId: ids.ledger, userId: ids.rafael, offline: () => {}, refuse: () => {} } as never, { type: "chat", text: "hello" } as never);
  assert.equal((await activeRoute(ids.ledger))?.threadId, ids.thread);
});

test("artifacts, follow-ups and teammate threads from a private chat stay with whoever asked", { skip }, async () => {
  const { getDb, schema } = await import("@/lib/db");
  const { artifactVisible, listArtifacts } = await import("./artifacts/service");
  const { bookFollowup, fireDueFollowups, pendingFollowups } = await import("./followups");
  const { listPairs, loadPair } = await import("./pair-threads");
  const db = getDb();
  const { hub, computer } = await connectedHub();

  await db.insert(schema.artifacts).values([
    { id: "art_priv_rafael", agentId: ids.ledger, title: "Rafael's refund", kind: "markdown", audienceId: ids.rafael },
    { id: "art_priv_shared", agentId: ids.ledger, title: "Weekly report", kind: "markdown" },
  ]);
  await db.insert(schema.artifactVersions).values([
    { id: "arv_priv_rafael", artifactId: "art_priv_rafael", version: 1, kind: "markdown", name: "refund.md", size: 1, sha256: "x" },
    { id: "arv_priv_shared", artifactId: "art_priv_shared", version: 1, kind: "markdown", name: "report.md", size: 1, sha256: "y" },
  ]);
  assert.deepEqual((await listArtifacts(ids.ledger, 200, ids.tiago)).map((a) => a.id), ["art_priv_shared"]);
  assert.equal((await listArtifacts(ids.ledger, 200, ids.rafael)).length, 2);
  assert.equal(await artifactVisible(ids.ledger, "art_priv_rafael", ids.marina), false);

  hub.setTurnAudience(ids.ledger, ids.rafael);
  const booked = await bookFollowup(hub, { id: ids.ledger }, { when: "2h", note: "check the Aurora refund" }, { runId: null, outsider: false });
  assert.ok(booked.ok);
  hub.setTurnAudience(ids.ledger, null);
  assert.equal((await pendingFollowups([ids.ledger], 100, ids.tiago)).length, 0);
  assert.equal((await pendingFollowups([ids.ledger], 100, ids.rafael)).length, 1);
  await db.update(schema.followups).set({ dueAt: new Date(Date.now() - 1000) }).where(eq(schema.followups.agentId, ids.ledger));
  await fireDueFollowups(hub);
  assert.equal(computer.received.find((m) => m.type === "chat" && m.followup)?.askedBy, ids.rafael);

  await db.insert(schema.agentMessages).values([
    { id: "amsg_priv_1", fromAgentId: ids.ledger, toAgentId: ids.penny, kind: "message", text: "is Rafael's refund approved?", audienceId: ids.rafael },
    { id: "amsg_priv_2", fromAgentId: ids.penny, toAgentId: ids.ledger, kind: "message", text: "weekly numbers are in" },
  ]);
  assert.deepEqual((await loadPair(ids.ledger, ids.penny, 200, ids.tiago)).rows.map((r) => r.id), ["amsg_priv_2"]);
  assert.equal((await loadPair(ids.ledger, ids.penny, 200, ids.rafael)).rows.length, 2);
  assert.equal((await listPairs([ids.ledger], 500, ids.tiago))[0]?.last.id, "amsg_priv_2");
});

test("a follow-up from a private chat never starts a task run the whole team sees, even one booked before this rule", { skip }, async () => {
  const { getDb, schema } = await import("@/lib/db");
  const { bookFollowup, fireDueFollowups } = await import("./followups");
  const db = getDb();
  const { hub, computer } = await connectedHub();
  await db.insert(schema.recipes).values({ id: "rcp_priv_inbox", agentId: ids.ledger, active: true, recipe: { title: "Check inbox", trigger: "x", steps: [{ id: "s1", text: "Read", mode: "auto" }], questions: [], askFirstRuns: 0 } });
  try {
    hub.setTurnAudience(ids.ledger, ids.rafael);
    const booked = await bookFollowup(hub, { id: ids.ledger }, { when: "2h", note: "check HR's reply on my salary", task: "Check inbox" }, { runId: null, outsider: false });
    hub.setTurnAudience(ids.ledger, null);
    assert.equal(booked.ok, false);
    assert.equal(!booked.ok && booked.reason, "private_task");

    await db.insert(schema.followups).values({ id: "fu_priv_legacy", agentId: ids.ledger, dueAt: new Date(Date.now() - 1000), note: "check HR's reply on my salary", recipeId: "rcp_priv_inbox", chainId: "fuc_priv_legacy", emptyWakes: 0, askedBy: ids.rafael });
    const fired = await fireDueFollowups(hub);
    assert.equal(fired.find((f) => f.id === "fu_priv_legacy")?.runId ?? null, null);
    assert.equal((await db.select().from(schema.runs).where(eq(schema.runs.recipeId, "rcp_priv_inbox"))).length, 0);
    const woke = computer.received.filter((m) => m.type === "chat" && m.followup && (m.followup as { id: string }).id === "fu_priv_legacy");
    assert.equal(woke.length, 1);
    assert.equal(woke[0].askedBy, ids.rafael);
  } finally {
    await db.delete(schema.followups).where(eq(schema.followups.id, "fu_priv_legacy"));
    await db.delete(schema.recipes).where(eq(schema.recipes.id, "rcp_priv_inbox"));
  }
});

test("vault names and brain logins go only to whoever manages the understudy", { skip }, async () => {
  const { computerHandlers } = await import("./hub/computer-handlers");
  const { hub } = await connectedHub();
  const [marina, rafael] = [socket(), socket()];
  await hub.attachViewer(marina as never, ids.ledger, ids.marina, "owner");
  await hub.attachViewer(rafael as never, ids.ledger, ids.rafael, "member");
  await computerHandlers.credentials(hub, ids.ledger, { type: "credentials", credentials: [{ name: "Bank", username: "marina", site: "bank.example.test" }] } as never);
  computerHandlers.login_prompt(hub, ids.ledger, { type: "login_prompt", brain: "claude", url: "https://login.example.test", code: "ABCD" } as never);
  assert.ok(marina.received.some((m) => m.type === "credentials"));
  assert.ok(marina.received.some((m) => m.type === "login_prompt"));
  assert.ok(!rafael.received.some((m) => m.type === "credentials" || m.type === "login_prompt"));
});

test("cancelling a person's waiting approvals leaves everyone else's", { skip }, async () => {
  const { getDb, schema } = await import("@/lib/db");
  const { hub } = await connectedHub();
  hub.setTurnAudience(ids.ledger, ids.rafael);
  const rafaels = await hub.createApproval(ids.ledger, { summary: "Refund for Rafael" }, "mcp", 3600);
  hub.setTurnAudience(ids.ledger, null);
  const owners = await hub.createApproval(ids.ledger, { summary: "Pay the rent" }, "mcp", 3600);
  assert.equal(await hub.cancelApprovals(ids.ledger, ids.marina, { askedBy: ids.rafael }), 1);
  const rows = await getDb().select({ id: schema.approvals.id, status: schema.approvals.status }).from(schema.approvals).where(inArray(schema.approvals.id, [rafaels, owners]));
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.id, r.status])), { [rafaels]: "cancelled", [owners]: "pending" });
  await hub.cancelApprovals(ids.ledger, null);
});

test("a task suggestion from a member's chat reaches that member and whoever can save it, nobody else", { skip }, async () => {
  const { loadChat } = await import("@/lib/views");
  const { hub } = await connectedHub();
  const [marina, rafael, tiago] = [socket(), socket(), socket()];
  await hub.attachViewer(marina as never, ids.ledger, ids.marina, "owner");
  await hub.attachViewer(rafael as never, ids.ledger, ids.rafael, "member");
  await hub.attachViewer(tiago as never, ids.ledger, ids.tiago, "member");
  hub.setTurnAudience(ids.ledger, ids.rafael);
  const recipe = { title: "Chase Rafael's late refunds", trigger: "every Friday", steps: [{ id: "s1", text: "Open the refunds sheet", mode: "auto" as const }, { id: "s2", text: "Email each school", mode: "ask" as const }], questions: [], askFirstRuns: 3 };
  const proposed = await hub.proposals.propose(ids.ledger, { recipe, cron: null, timezone: "UTC", reason: "Third time this month.", origin: "repeated" });
  hub.setTurnAudience(ids.ledger, null);
  assert.ok(proposed.ok);
  const cards = (ws: { received: { type: string }[] }) => ws.received.filter((m) => m.type === "chat").length;
  assert.deepEqual([cards(marina), cards(rafael), cards(tiago)], [1, 1, 0]);
  const hasCard = async (userId: string, manages: boolean) => (await loadChat(ids.ledger, 50, userId, manages)).some((m) => m.proposal?.id === (proposed.ok ? proposed.id : ""));
  assert.equal(await hasCard(ids.rafael, false), true);
  assert.equal(await hasCard(ids.marina, true), true);
  assert.equal(await hasCard(ids.tiago, false), false);
});
