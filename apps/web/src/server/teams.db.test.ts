import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { after, before, test } from "node:test";
import { eq, inArray } from "drizzle-orm";

const url = process.env.TEST_DATABASE_URL;
const skip = !url && "set TEST_DATABASE_URL to a disposable Postgres to run";

if (url) process.env.DATABASE_URL = url;

const ids = {
  marina: "usr_team_marina",
  rafael: "usr_team_rafael",
  tiago: "usr_team_tiago",
  outsider: "usr_team_outsider",
  ledger: "agt_team_ledger",
  penny: "agt_team_penny",
  open: "srv_team_open",
  restricted: "srv_team_restricted",
  oauth: "srv_team_oauth",
};

const tools = (servers: string[]) => ({ notifyOwner: true, slack: false, slackChannels: [], servers });
const look = { body: "pill", color: "#7FB2FF", eyes: "dot", acc: "none", accColor: "#2F3A56" };

async function cleanup() {
  const { getDb, schema } = await import("@/lib/db");
  const db = getDb();
  await db.delete(schema.teams).where(eq(schema.teams.createdBy, ids.marina));
  await db.delete(schema.mcpServers).where(inArray(schema.mcpServers.id, [ids.open, ids.restricted, ids.oauth]));
  await db.delete(schema.user).where(inArray(schema.user.id, [ids.marina, ids.rafael, ids.tiago, ids.outsider]));
}

before(async () => {
  if (!url) return;
  const { getDb, schema } = await import("@/lib/db");
  const db = getDb();
  await (await import("./test-db")).migrateTestDb();
  await cleanup();
  await db.insert(schema.user).values([
    { id: ids.marina, name: "Marina Souza", email: "marina@team.test", status: "approved" },
    { id: ids.rafael, name: "Rafael Lima", email: "rafael@team.test", status: "approved" },
    { id: ids.tiago, name: "Tiago Kato", email: "tiago@team.test", status: "approved" },
    { id: ids.outsider, name: "Out Sider", email: "outsider@team.test", status: "approved" },
  ]);
  await db.insert(schema.mcpServers).values([
    { id: ids.open, name: "Drive", slug: "team-test-drive", url: "https://drive.example.test/mcp" },
    { id: ids.restricted, name: "Mine only", slug: "team-test-mine", url: "https://mine.example.test/mcp", allowedEmails: ["marina@team.test"] },
    { id: ids.oauth, name: "Mail", slug: "team-test-mail", url: "https://mail.example.test/mcp", oauthClient: "sealed" },
  ]);
  await db.insert(schema.agents).values([
    { id: ids.ledger, ownerId: ids.marina, name: "Ledger", look, tokenHash: "hash_team_ledger", tools: tools([ids.open, ids.restricted, ids.oauth]) } as never,
    { id: ids.penny, ownerId: ids.tiago, name: "Penny", look, tokenHash: "hash_team_penny", tools: tools([]) } as never,
  ]);
});

after(async () => {
  if (!url) return;
  await cleanup();
  const { getPool } = await import("@/lib/db");
  await getPool().end();
});

async function makeTeam() {
  const store = await import("./teams-store");
  const created = await store.createTeam(ids.marina, { name: "  Finance  ", description: "Billing" });
  assert.ok(created.ok);
  const teamId = created.ok ? created.id : "";
  assert.deepEqual(await store.addMember(teamId, ids.marina, "Rafael@Team.test", "member"), { ok: true });
  assert.deepEqual(await store.addMember(teamId, ids.marina, "tiago@team.test", "member"), { ok: true });
  return teamId;
}

test("only team admins invite, and a team keeps at least one admin", { skip }, async () => {
  const store = await import("./teams-store");
  const teamId = await makeTeam();
  assert.equal((await store.addMember(teamId, ids.rafael, "outsider@team.test", "admin")).ok, false);
  assert.equal((await store.addMember(teamId, ids.marina, "nobody@team.test", "member")).ok, false);
  assert.equal((await store.setMemberRole(teamId, ids.marina, ids.marina, "member")).ok, false);
  assert.equal((await store.removeMember(teamId, ids.marina, ids.marina)).ok, false);
  assert.equal((await store.removeMember(teamId, ids.rafael, ids.tiago)).ok, false);
  const team = await store.loadTeam(teamId, ids.rafael);
  assert.equal(team?.team.name, "Finance");
  assert.equal(team?.role, "member");
  assert.equal(await store.loadTeam(teamId, ids.outsider), null);
});

test("bringing an agent drops personal connectors and gives the team access", { skip }, async () => {
  const { getDb, schema } = await import("@/lib/db");
  const { agentAccess, accessibleAgentIds } = await import("@/lib/access");
  const store = await import("./teams-store");
  const teamId = await makeTeam();
  assert.equal((await store.bringAgent(ids.ledger, ids.rafael, teamId, true)).ok, false);
  const brought = await store.bringAgent(ids.ledger, ids.marina, teamId, true);
  assert.ok(brought.ok);
  assert.deepEqual(brought.ok ? brought.removed.sort() : [], ["Mail", "Mine only"]);
  const [row] = await getDb().select().from(schema.agents).where(eq(schema.agents.id, ids.ledger));
  assert.deepEqual(row.tools.servers, [ids.open]);
  assert.equal(await agentAccess(ids.rafael, ids.ledger), "member");
  assert.equal(await agentAccess(ids.outsider, ids.ledger), null);
  assert.ok((await accessibleAgentIds(ids.rafael)).includes(ids.ledger));
  assert.ok(!(await accessibleAgentIds(ids.rafael, ["owner", "admin", "approver"])).includes(ids.ledger));
  assert.deepEqual((await store.loadTeam(teamId, ids.tiago))?.connectors.map((c) => c.name), ["Drive"]);
  await store.setMemberRole(teamId, ids.marina, ids.rafael, "admin");
  assert.equal(await agentAccess(ids.rafael, ids.ledger), "admin");
  assert.equal((await store.releaseAgent(ids.ledger, ids.tiago)).ok, false);
  assert.ok((await store.releaseAgent(ids.ledger, ids.rafael)).ok);
  assert.equal(await agentAccess(ids.rafael, ids.ledger), null);
});

test("a lent agent stays the lender's to edit and leaves with them", { skip }, async () => {
  const { getDb, schema } = await import("@/lib/db");
  const { agentAccess } = await import("@/lib/access");
  const store = await import("./teams-store");
  const teamId = await makeTeam();
  assert.ok((await store.bringAgent(ids.penny, ids.tiago, teamId, false)).ok);
  assert.equal(await agentAccess(ids.marina, ids.penny), "member");
  assert.equal((await store.releaseAgent(ids.penny, ids.marina)).ok, false);
  assert.ok((await store.removeMember(teamId, ids.tiago, ids.tiago)).ok);
  const [row] = await getDb().select().from(schema.agents).where(eq(schema.agents.id, ids.penny));
  assert.equal(row.teamId, null);
  assert.equal(await agentAccess(ids.marina, ids.penny), null);
});

test("a member's chat and approvals stay with that member", { skip }, async () => {
  const { getDb, schema } = await import("@/lib/db");
  const { approvalScope, canAnswer } = await import("@/lib/access");
  const { loadChat, loadPendingApprovals } = await import("@/lib/views");
  const { Hub } = await import("./hub");
  const store = await import("./teams-store");
  const db = getDb();
  const teamId = await makeTeam();
  assert.ok((await store.bringAgent(ids.ledger, ids.marina, teamId, true)).ok);
  const hub = new Hub();
  hub.setTurnAudience(ids.ledger, ids.rafael);
  await hub.addMessage(ids.ledger, "user", "north list please", null, ids.rafael, undefined, undefined, undefined, undefined, undefined, ids.rafael);
  await hub.addMessage(ids.ledger, "agent", "5 schools", null, undefined, undefined, undefined, undefined, undefined, undefined, hub.turnAudience(ids.ledger));
  const approvalId = await hub.createApproval(ids.ledger, { summary: "send 3 emails" }, "mcp", 3600);
  hub.setTurnAudience(ids.ledger, null);
  await hub.addMessage(ids.ledger, "system", "weekly run done", "run_x");

  const forRafael = await loadChat(ids.ledger, 50, ids.rafael);
  const forTiago = await loadChat(ids.ledger, 50, ids.tiago);
  assert.deepEqual(forRafael.map((m) => m.text), ["north list please", "5 schools", "weekly run done"]);
  assert.deepEqual(forTiago.map((m) => m.text), ["weekly run done"]);
  assert.equal((await loadPendingApprovals(ids.ledger, ids.tiago)).length, 0);
  assert.equal((await loadPendingApprovals(ids.ledger, ids.rafael))[0]?.forYou, true);

  const [approval] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId));
  assert.equal(approval.askedBy, ids.rafael);
  assert.equal(canAnswer("owner", approval.askedBy, ids.marina), false);
  assert.equal(canAnswer("member", approval.askedBy, ids.rafael), true);
  const scoped = async (userId: string) =>
    db.select({ id: schema.approvals.id }).from(schema.approvals).where(await approvalScope(userId)).then((rows) => rows.map((row) => row.id));
  assert.ok((await scoped(ids.rafael)).includes(approvalId));
  assert.ok(!(await scoped(ids.marina)).includes(approvalId));
  assert.equal(await hub.answerApproval(approvalId, true, undefined, ids.marina), false);
  assert.equal(await hub.answerApproval(approvalId, true, undefined, ids.rafael), true);
  const [agent] = await db.select({ note: schema.agents.stateNote }).from(schema.agents).where(eq(schema.agents.id, ids.ledger));
  assert.ok(agent.note === null || !agent.note.includes("send 3 emails"));
});

test("what reaches a team agent outside a member's turn is not kept private to that member", { skip }, async () => {
  const { getDb, schema } = await import("@/lib/db");
  const { loadChat } = await import("@/lib/views");
  const { Hub } = await import("./hub");
  const { computerHandlers } = await import("./hub/computer-handlers");
  const store = await import("./teams-store");
  const db = getDb();
  const teamId = await makeTeam();
  assert.ok((await store.bringAgent(ids.penny, ids.tiago, teamId, true)).ok);
  const hub = new Hub();
  const viewer = () => {
    const ws = Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, received: [] as { type: string }[], send(raw: string) { ws.received.push(JSON.parse(raw)); }, ping() {}, close() {} });
    return ws;
  };
  const [tiagoWs, rafaelWs, marinaWs] = [viewer(), viewer(), viewer()];
  await hub.attachViewer(tiagoWs as never, ids.penny, ids.tiago, "owner");
  await hub.attachViewer(rafaelWs as never, ids.penny, ids.rafael, "member");
  await hub.attachViewer(marinaWs as never, ids.penny, ids.marina, "member");

  await computerHandlers.turn(hub, ids.penny, { type: "turn", askedBy: ids.rafael });
  await computerHandlers.chat(hub, ids.penny, { type: "chat", role: "understudy", text: "the Aurora refund is 3 days late" } as never);
  computerHandlers.frame(hub, ids.penny, { type: "frame", jpegBase64: "AAAA", width: 10, height: 10, url: "https://bank.example.test/refunds" });
  await hub.notifyOwner(ids.penny, "Rafael asked about a refund");
  await hub.addMessage(ids.penny, "user", "how is the week going?", null, ids.tiago, "slack");

  const frames = (ws: { received: { type: string }[] }) => ws.received.filter((m) => m.type === "frame").length;
  assert.equal(frames(rafaelWs), 1);
  assert.equal(frames(tiagoWs), 1);
  assert.equal(frames(marinaWs), 0);
  const late = viewer();
  await hub.attachViewer(late as never, ids.penny, ids.marina, "member");
  const snapshot = late.received.find((m) => m.type === "snapshot") as { frame: unknown } | undefined;
  assert.equal(snapshot?.frame, null);

  const texts = async (userId: string) => (await loadChat(ids.penny, 50, userId)).map((m) => m.text);
  assert.deepEqual(await texts(ids.rafael), ["the Aurora refund is 3 days late", "how is the week going?"]);
  assert.deepEqual(await texts(ids.tiago), ["Rafael asked about a refund", "how is the week going?"]);
  assert.deepEqual(await texts(ids.marina), ["how is the week going?"]);
  await db.delete(schema.messages).where(eq(schema.messages.agentId, ids.penny));
});
