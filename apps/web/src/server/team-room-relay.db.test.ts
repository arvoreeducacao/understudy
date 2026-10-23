import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { eq, inArray } from "drizzle-orm";
import type { Recipe } from "@understudy/protocol";

const url = process.env.TEST_DATABASE_URL;
const skip = !url && "set TEST_DATABASE_URL to a disposable Postgres to run";

if (url) process.env.DATABASE_URL = url;

const ids = {
  owner: "usr_relay_owner",
  mate: "usr_relay_mate",
  scout: "agt_relay_scout",
  analyst: "agt_relay_analyst",
  editor: "agt_relay_editor",
  sweep: "rcp_relay_sweep",
  digest: "rcp_relay_digest",
};

const recipe = (title: string): Recipe => ({ title, trigger: "every Monday", steps: [{ id: "s1", text: "Read the sources", mode: "auto" }] }) as Recipe;

const look = { body: "pill", color: "#7FB2FF", eyes: "dot", acc: "none", accColor: "#2F3A56" };
const tools = { notifyOwner: true, slack: false, slackChannels: [] };
let teamId = "";

type Delivered = { agentId: string; type: string; prompt?: string };

function fakeHub(turnRoom: string | null = null) {
  const delivered: Delivered[] = [];
  const hub = {
    delivered,
    isOnline: () => true,
    deliver: async (agentId: string, message: { type: string; prompt?: string }) => {
      delivered.push({ agentId, type: message.type, prompt: message.prompt });
      return { status: "sent" };
    },
    addMessage: async () => {},
    broadcast: () => {},
    turnAudience: () => null,
    turnRoom: () => turnRoom,
    startRun: async (recipeId: string) => {
      const { getDb, schema } = await import("@/lib/db");
      const { newId } = await import("@/lib/ids");
      const [found] = await getDb().select({ agentId: schema.recipes.agentId }).from(schema.recipes).where(eq(schema.recipes.id, recipeId));
      const runId = newId("run");
      await getDb().insert(schema.runs).values({ id: runId, agentId: found.agentId, recipeId, trigger: "handoff" });
      return { ok: true, runId };
    },
    rooms: null as unknown,
  };
  return hub;
}

before(async () => {
  if (!url) return;
  const { getDb, schema } = await import("@/lib/db");
  const db = getDb();
  await (await import("./test-db")).migrateTestDb();
  await db.delete(schema.teams).where(eq(schema.teams.createdBy, ids.owner));
  await db.delete(schema.user).where(inArray(schema.user.id, [ids.owner, ids.mate]));
  await db.insert(schema.user).values([
    { id: ids.owner, name: "Marina Souza", email: "marina@relay.test", status: "approved" },
    { id: ids.mate, name: "Rafael Lima", email: "rafael@relay.test", status: "approved" },
  ]);
  await db.insert(schema.agents).values([
    { id: ids.scout, ownerId: ids.owner, name: "Scout", look, tokenHash: "hash_relay_scout", tools },
    { id: ids.analyst, ownerId: ids.owner, name: "Analyst", look, tokenHash: "hash_relay_analyst", tools },
    { id: ids.editor, ownerId: ids.owner, name: "Editor", look, tokenHash: "hash_relay_editor", tools },
  ] as never);
  await db.insert(schema.recipes).values([
    { id: ids.sweep, agentId: ids.analyst, recipe: recipe("Weekly analysis") },
    { id: ids.digest, agentId: ids.editor, recipe: recipe("Monday digest") },
  ]);
  const store = await import("./teams-store");
  const created = await store.createTeam(ids.owner, { name: "Marketing" });
  teamId = created.ok ? created.id : "";
  await store.addMember(teamId, ids.owner, "rafael@relay.test", "member");
  for (const agentId of [ids.scout, ids.analyst, ids.editor]) await store.bringAgent(agentId, ids.owner, teamId, true);
});

beforeEach(async () => {
  if (!url) return;
  const { getDb, schema } = await import("@/lib/db");
  const db = getDb();
  await db.delete(schema.rooms).where(eq(schema.rooms.ownerId, ids.owner));
  await db.delete(schema.agentMessages).where(inArray(schema.agentMessages.fromAgentId, [ids.scout, ids.analyst, ids.editor]));
  await db.delete(schema.runs).where(inArray(schema.runs.agentId, [ids.scout, ids.analyst, ids.editor]));
});

after(async () => {
  if (!url) return;
  const { getDb, schema, getPool } = await import("@/lib/db");
  await getDb().delete(schema.teams).where(eq(schema.teams.createdBy, ids.owner));
  await getDb().delete(schema.user).where(inArray(schema.user.id, [ids.owner, ids.mate]));
  await getPool().end();
});

async function openGroup(name: string, agentIds: string[]) {
  const { createTeamRoom } = await import("./room-store");
  const created = await createTeamRoom(ids.owner, { teamId, name, agentIds, peopleIds: [ids.mate] });
  assert.ok(created.ok);
  return created.ok ? created.id : "";
}

async function toolsOf(hub: ReturnType<typeof fakeHub>, agentId: string) {
  const { getDb, schema } = await import("@/lib/db");
  const { Rooms } = await import("./hub/rooms");
  const { teamTools } = await import("./team");
  hub.rooms = new Rooms(hub as never);
  const [agent] = await getDb().select().from(schema.agents).where(eq(schema.agents.id, agentId));
  const list = teamTools(hub as never, agent);
  const tool = (name: string) => list.find((t) => t.name === name)!.run as unknown as (args: object) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  return { handOff: tool("hand_off"), message: tool("message_agent") };
}

async function inRun(agentId: string) {
  const { getDb, schema } = await import("@/lib/db");
  const { newId } = await import("@/lib/ids");
  const { noteTurn } = await import("./followups");
  const runId = newId("run");
  await getDb().insert(schema.runs).values({ id: runId, agentId, trigger: "schedule" });
  noteTurn(agentId, { runId });
  return runId;
}

async function said(roomId: string) {
  const { loadRoomMessages } = await import("./room-store");
  return (await loadRoomMessages(roomId)).map((row) => ({ author: row.author, agentId: row.agentId, runId: row.runId, text: row.text }));
}

test("a hand-off during a task shows up in the group they share, under the one who hands it, linked to the run it started, waking nobody", { skip }, async () => {
  const { getDb, schema } = await import("@/lib/db");
  const roomId = await openGroup("competitor-radar", [ids.scout, ids.analyst, ids.editor]);
  const hub = fakeHub();
  await inRun(ids.scout);
  const { handOff } = await toolsOf(hub, ids.scout);
  const result = await handOff({ agent: "Analyst", task: "Weekly analysis", input: "x".repeat(5000), note: "sweep for the week is ready — 2 changes, 8 with no news" });
  assert.equal(result.isError, undefined);
  const [handoff] = await getDb().select().from(schema.agentMessages).where(eq(schema.agentMessages.fromAgentId, ids.scout));
  assert.deepEqual(await said(roomId), [{ author: "agent", agentId: ids.scout, runId: handoff.runId, text: "@Analyst, “Weekly analysis” is yours: sweep for the week is ready — 2 changes, 8 with no news" }]);
  assert.deepEqual(hub.delivered.filter((d) => d.type === "room_turn"), []);
  const seats = await getDb().select().from(schema.roomParticipants).where(eq(schema.roomParticipants.roomId, roomId));
  assert.ok(seats.every((seat) => seat.turnStartedAt === null));
});

test("without a note the line is the start of the input, cut short", { skip }, async () => {
  const roomId = await openGroup("competitor-radar", [ids.scout, ids.analyst]);
  await inRun(ids.scout);
  const { handOff } = await toolsOf(fakeHub(), ids.scout);
  await handOff({ agent: "Analyst", task: "Weekly analysis", input: `Sweep of the week:\n\n${"Acme changed its pricing page and launched a new plan. ".repeat(20)}` });
  const [line] = await said(roomId);
  assert.ok(line.text.startsWith("@Analyst, “Weekly analysis” is yours: Sweep of the week: Acme changed its pricing page"));
  assert.ok(line.text.endsWith("…") || line.text.endsWith("."));
  assert.ok(line.text.length < 260);
});

test("when the run it started finishes, the one who got it closes the line in the same group, ok or failed", { skip }, async () => {
  const { getDb, schema } = await import("@/lib/db");
  const { Runs } = await import("./hub/runs");
  const roomId = await openGroup("competitor-radar", [ids.scout, ids.analyst, ids.editor]);
  const hub = fakeHub();
  await inRun(ids.scout);
  const { handOff } = await toolsOf(hub, ids.scout);
  await handOff({ agent: "Analyst", task: "Weekly analysis", input: "8 sources read", note: "sweep is ready" });
  const [handoff] = await getDb().select().from(schema.agentMessages).where(eq(schema.agentMessages.fromAgentId, ids.scout));
  const runs = new Runs(hub as never);
  await runs.finish(ids.analyst, handoff.runId!, true, "Two real moves this week: Acme pricing and Globex hiring. Report sent to Editor.");
  const lines = await said(roomId);
  assert.deepEqual(lines.at(-1), { author: "agent", agentId: ids.analyst, runId: handoff.runId, text: "Done with “Weekly analysis”: Two real moves this week: Acme pricing and Globex hiring." });
  assert.deepEqual(hub.delivered.filter((d) => d.type === "room_turn"), []);

  await inRun(ids.scout);
  await handOff({ agent: "Analyst", task: "Weekly analysis", input: "again" });
  const [, second] = await getDb().select().from(schema.agentMessages).where(eq(schema.agentMessages.fromAgentId, ids.scout)).orderBy(schema.agentMessages.createdAt);
  await runs.finish(ids.analyst, second.runId!, false, "The pricing page asked for a login.");
  assert.equal((await said(roomId)).at(-1)?.text, "“Weekly analysis” did not finish: The pricing page asked for a login.");
});

test("a run started some other way posts nothing when it finishes", { skip }, async () => {
  const { Runs } = await import("./hub/runs");
  const roomId = await openGroup("competitor-radar", [ids.scout, ids.analyst]);
  const runId = await inRun(ids.analyst);
  await new Runs(fakeHub() as never).finish(ids.analyst, runId, true, "done");
  assert.deepEqual(await said(roomId), []);
});

test("with more than one group in common, the line goes to the one with the latest activity", { skip }, async () => {
  const { getDb, schema } = await import("@/lib/db");
  const older = await openGroup("radar", [ids.scout, ids.analyst]);
  const newer = await openGroup("marketing", [ids.scout, ids.analyst, ids.editor]);
  await getDb().update(schema.rooms).set({ updatedAt: new Date(Date.now() - 60_000) }).where(eq(schema.rooms.id, newer));
  await getDb().update(schema.rooms).set({ updatedAt: new Date() }).where(eq(schema.rooms.id, older));
  await inRun(ids.scout);
  const { handOff } = await toolsOf(fakeHub(), ids.scout);
  await handOff({ agent: "Analyst", task: "Weekly analysis", input: "ready" });
  assert.equal((await said(older)).length, 1);
  assert.equal((await said(newer)).length, 0);
});

test("a message to a teammate during a task is posted too, and a group without both of them gets nothing", { skip }, async () => {
  const both = await openGroup("radar", [ids.scout, ids.analyst]);
  const without = await openGroup("editing", [ids.scout, ids.editor]);
  const runId = await inRun(ids.scout);
  const hub = fakeHub();
  const { message } = await toolsOf(hub, ids.scout);
  await message({ agent: "Analyst", text: "Did Acme's new plan replace the old one or sit next to it?" });
  assert.deepEqual(await said(both), [{ author: "agent", agentId: ids.scout, runId, text: "@Analyst, Did Acme's new plan replace the old one or sit next to it?" }]);
  assert.deepEqual(await said(without), []);
  assert.deepEqual(hub.delivered.map((d) => [d.agentId, d.type]), [[ids.analyst, "chat"]]);
});

test("a hand-off asked in a private chat stays out of the group", { skip }, async () => {
  const roomId = await openGroup("radar", [ids.scout, ids.analyst]);
  const { noteTurn } = await import("./followups");
  noteTurn(ids.scout, {});
  const { handOff, message } = await toolsOf(fakeHub(), ids.scout);
  await handOff({ agent: "Analyst", task: "Weekly analysis", input: "my private notes about the board meeting" });
  await message({ agent: "Analyst", text: "between us" });
  assert.deepEqual(await said(roomId), []);
});

test("later, a person naming the agent wakes it with those lines in its transcript", { skip }, async () => {
  const { Rooms } = await import("./hub/rooms");
  const roomId = await openGroup("radar", [ids.scout, ids.analyst]);
  await inRun(ids.scout);
  const hub = fakeHub();
  const { handOff } = await toolsOf(hub, ids.scout);
  await handOff({ agent: "Analyst", task: "Weekly analysis", input: "ready", note: "sweep is ready" });
  await (hub.rooms as InstanceType<typeof Rooms>).personSaid(roomId, ids.mate, "@Analyst what changed at Acme?");
  const woken = hub.delivered.filter((d) => d.type === "room_turn");
  assert.deepEqual(woken.map((d) => d.agentId), [ids.analyst]);
  assert.match(woken[0].prompt ?? "", /Scout \(understudy\): "@Analyst, “Weekly analysis” is yours: sweep is ready"/);
  assert.match(woken[0].prompt ?? "", /The ones under your name are yours/);
});
