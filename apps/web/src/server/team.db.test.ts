import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq, inArray } from "drizzle-orm";

const url = process.env.TEST_DATABASE_URL;
const skip = !url && "set TEST_DATABASE_URL to a disposable Postgres to run";

if (url) process.env.DATABASE_URL = url;

const ids = { owner: "usr_team_owner", other: "usr_team_other", mine: "agt_team_mine", mate: "agt_team_mate", foreign: "agt_team_foreign", team: "team_team_crew", lead: "agt_team_lead", crew: "agt_team_crew" };

before(async () => {
  if (!url) return;
  const { getDb, schema } = await import("@/lib/db");
  const db = getDb();
  await (await import("./test-db")).migrateTestDb();
  await db.delete(schema.teams).where(eq(schema.teams.id, ids.team));
  await db.delete(schema.user).where(inArray(schema.user.id, [ids.owner, ids.other]));
  await db.insert(schema.user).values([
    { id: ids.owner, name: "Owner", email: "team-owner@test.local", status: "approved" },
    { id: ids.other, name: "Other", email: "team-other@test.local", status: "approved" },
  ]);
  const tools = { notifyOwner: true, slack: false, slackChannels: [] };
  const look = { body: "pill", color: "#7FB2FF", eyes: "dot", acc: "none", accColor: "#2F3A56" };
  await db.insert(schema.agents).values([
    { id: ids.mine, ownerId: ids.owner, name: "Ada", look, tokenHash: "hash_team_mine", tools } as never,
    { id: ids.mate, ownerId: ids.owner, name: "Ben", look, tokenHash: "hash_team_mate", tools } as never,
    { id: ids.foreign, ownerId: ids.other, name: "Cleo", look, tokenHash: "hash_team_foreign", tools } as never,
  ]);
  await db.insert(schema.teams).values({ id: ids.team, name: "Crew", createdBy: ids.owner });
  await db.insert(schema.teamMembers).values([
    { teamId: ids.team, userId: ids.owner, role: "admin" },
    { teamId: ids.team, userId: ids.other, role: "member" },
  ]);
  await db.insert(schema.agents).values([
    { id: ids.lead, ownerId: ids.owner, name: "Eli", look, tokenHash: "hash_team_lead", tools, teamId: ids.team } as never,
    { id: ids.crew, ownerId: ids.other, name: "Dora", look, tokenHash: "hash_team_crew", tools, teamId: ids.team } as never,
  ]);
  await db.insert(schema.agentMembers).values({ agentId: ids.foreign, userId: ids.owner, role: "approver" });
});

after(async () => {
  if (!url) return;
  const { getDb, schema, getPool } = await import("@/lib/db");
  await getDb().delete(schema.teams).where(eq(schema.teams.id, ids.team));
  await getDb().delete(schema.user).where(inArray(schema.user.id, [ids.owner, ids.other]));
  await getPool().end();
});

test("an agent shared with the owner by someone else is not a teammate, so it can be neither messaged nor handed work", { skip }, async () => {
  const { listTeammates, pickTeammate } = await import("./team");
  const mates = await listTeammates({ id: ids.mine, ownerId: ids.owner });
  assert.deepEqual(mates.map((mate) => mate.id).sort(), [ids.lead, ids.mate].sort());
  assert.equal(pickTeammate(mates, "Cleo"), null);
  assert.equal(pickTeammate(mates, ids.foreign), null);
  const theirs = await listTeammates({ id: ids.foreign, ownerId: ids.other });
  assert.deepEqual(theirs.map((mate) => mate.id), [ids.crew]);
});

test("on a team, the understudies of the other people on it are teammates too, and say whose they are", { skip }, async () => {
  const { listTeammates } = await import("./team");
  const lead = await listTeammates({ id: ids.lead, ownerId: ids.owner, teamId: ids.team });
  assert.deepEqual(lead.map((mate) => [mate.name, mate.owner]).sort(), [["Ada", null], ["Ben", null], ["Dora", "Other"]]);
  const crew = await listTeammates({ id: ids.crew, ownerId: ids.other, teamId: ids.team });
  assert.deepEqual(crew.map((mate) => [mate.name, mate.owner]).sort(), [["Cleo", null], ["Eli", "Owner"]]);
  const ownOnly = await listTeammates({ id: ids.lead, ownerId: ids.owner, teamId: ids.team }, { team: false });
  assert.deepEqual(ownOnly.map((mate) => mate.name).sort(), ["Ada", "Ben"]);
});

function fakeHub() {
  const delivered: { agentId: string; text?: string; fromAgent?: unknown }[] = [];
  return {
    delivered,
    deliver: async (agentId: string, message: { text?: string; fromAgent?: unknown }) => {
      delivered.push({ agentId, text: message.text, fromAgent: message.fromAgent });
      return { status: "sent" };
    },
    addMessage: async () => {},
    turnAudience: () => null,
    turnRoom: () => null,
    startRun: async () => ({ ok: true, runId: "run_x" }),
  };
}

async function toolsFor(hub: ReturnType<typeof fakeHub>, agentId: string = ids.mine) {
  const { getDb, schema } = await import("@/lib/db");
  const { eq } = await import("drizzle-orm");
  const { teamTools } = await import("./team");
  const [agent] = await getDb().select().from(schema.agents).where(eq(schema.agents.id, agentId));
  const tools = teamTools(hub as never, agent);
  const tool = (name: string) => tools.find((t) => t.name === name)!.run as unknown as (args: object) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  return { message: tool("message_agent") };
}

async function clearPair() {
  const { getDb, schema } = await import("@/lib/db");
  await getDb().delete(schema.agentMessages).where(inArray(schema.agentMessages.fromAgentId, [ids.mine, ids.mate, ids.lead]));
  await getDb().delete(schema.inboundQueue).where(inArray(schema.inboundQueue.agentId, [ids.mine, ids.mate]));
}

test("a message to another owner's understudy on the team says whose understudy sent it", { skip }, async () => {
  await clearPair();
  const hub = fakeHub();
  const { message } = await toolsFor(hub, ids.lead);
  assert.equal((await message({ agent: "Dora", text: "is the Aurora invoice out?" })).isError, undefined);
  assert.equal((await message({ agent: "Ada", text: "Dora has the invoice" })).isError, undefined);
  assert.deepEqual(hub.delivered, [
    { agentId: ids.crew, text: "is the Aurora invoice out?", fromAgent: { id: ids.lead, name: "Eli", owner: "Owner" } },
    { agentId: ids.mine, text: "Dora has the invoice", fromAgent: { id: ids.lead, name: "Eli" } },
  ]);
  const offTeam = await toolsFor(hub, ids.mine);
  assert.equal((await offTeam.message({ agent: "Dora", text: "hi" })).isError, true);
});

test("with no ceiling set, two understudies can go back and forth far past the old limits", { skip }, async () => {
  delete process.env.UNDERSTUDY_AGENT_TALK_CEILING;
  await clearPair();
  const { getDb, schema } = await import("@/lib/db");
  const { newId } = await import("@/lib/ids");
  await getDb()
    .insert(schema.agentMessages)
    .values(Array.from({ length: 40 }, (_, i) => ({ id: newId("amsg"), fromAgentId: ids.mine, toAgentId: ids.mate, kind: "message" as const, text: "x", depth: i + 1 })));
  await getDb().insert(schema.agentMessages).values({ id: newId("amsg"), fromAgentId: ids.mate, toAgentId: ids.mine, kind: "message", text: "deep", depth: 50 });
  const hub = fakeHub();
  const { message } = await toolsFor(hub);
  const result = await message({ agent: "Ben", text: "one more" });
  assert.equal(result.isError, undefined);
  assert.deepEqual(hub.delivered.map((d) => d.agentId), [ids.mate]);
});

test("a ceiling set by the server refuses a message that goes past it", { skip }, async () => {
  await clearPair();
  const { getDb, schema } = await import("@/lib/db");
  const { newId } = await import("@/lib/ids");
  await getDb().insert(schema.agentMessages).values({ id: newId("amsg"), fromAgentId: ids.mate, toAgentId: ids.mine, kind: "message", text: "deep", depth: 4 });
  process.env.UNDERSTUDY_AGENT_TALK_CEILING = "4";
  try {
    const hub = fakeHub();
    const { message } = await toolsFor(hub);
    const result = await message({ agent: "Ben", text: "one more" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /4 messages deep/);
    assert.equal(hub.delivered.length, 0);
  } finally {
    delete process.env.UNDERSTUDY_AGENT_TALK_CEILING;
  }
});

test("Stop on a pair drops their queued messages to each other and refuses new ones until the owner lets them talk again", { skip }, async () => {
  await clearPair();
  const { getDb, schema } = await import("@/lib/db");
  const { newId } = await import("@/lib/ids");
  const { eq } = await import("drizzle-orm");
  const { listPairs, loadPair, pairStopped, setPairStopped } = await import("./pair-threads");
  const expiresAt = new Date(Date.now() + 60_000);
  await getDb()
    .insert(schema.inboundQueue)
    .values([
      { id: newId("inq"), agentId: ids.mate, message: { type: "chat", text: "queued", from: "Ada", fromAgent: { id: ids.mine, name: "Ada" } }, source: "team", expiresAt },
      { id: newId("inq"), agentId: ids.mate, message: { type: "chat", text: "from the owner", from: "Owner" }, source: "panel", expiresAt },
    ]);
  assert.equal(await setPairStopped(ids.mate, ids.mine, true), true);
  assert.equal(await setPairStopped(ids.mine, ids.mate, true), false);
  assert.equal(await pairStopped(ids.mine, ids.mate), true);
  const queued = await getDb().select().from(schema.inboundQueue).where(eq(schema.inboundQueue.agentId, ids.mate));
  assert.deepEqual(queued.map((row) => row.source), ["panel"]);

  const hub = fakeHub();
  const { message } = await toolsFor(hub);
  const refused = await message({ agent: "Ben", text: "are you there?" });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /owner stopped the conversation between you and Ben/);
  assert.equal(hub.delivered.length, 0);
  const [summary] = await listPairs([ids.mine]);
  assert.equal(summary.stopped, true);

  assert.equal(await setPairStopped(ids.mine, ids.mate, false), true);
  const allowed = await message({ agent: "Ben", text: "back to work" });
  assert.equal(allowed.isError, undefined);
  assert.deepEqual(hub.delivered.map((d) => d.text), ["back to work"]);
  const thread = await loadPair(ids.mate, ids.mine);
  assert.equal(thread.stopped, false);
  assert.deepEqual(thread.rows.map((row) => row.kind), ["stop", "resume", "message"]);
});
