import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { eq, inArray } from "drizzle-orm";

const url = process.env.TEST_DATABASE_URL;
const skip = !url && "set TEST_DATABASE_URL to a disposable Postgres to run";

if (url) process.env.DATABASE_URL = url;

const ids = { marina: "usr_troom_marina", rafael: "usr_troom_rafael", tiago: "usr_troom_tiago", ledger: "agt_troom_ledger", penny: "agt_troom_penny", mine: "agt_troom_mine" };

type Delivered = { agentId: string; message: { type: string; roomId?: string; prompt?: string; askedBy?: string } };

function fakeHub() {
  const delivered: Delivered[] = [];
  return {
    delivered,
    isOnline: () => true,
    deliver: async (agentId: string, message: Delivered["message"]) => {
      delivered.push({ agentId, message });
      return { status: "sent" };
    },
  };
}

const look = { body: "pill", color: "#7FB2FF", eyes: "dot", acc: "none", accColor: "#2F3A56" };
const tools = { notifyOwner: true, slack: false, slackChannels: [] };
let teamId = "";

before(async () => {
  if (!url) return;
  const { getDb, schema } = await import("@/lib/db");
  const db = getDb();
  await (await import("./test-db")).migrateTestDb();
  await db.delete(schema.teams).where(eq(schema.teams.createdBy, ids.marina));
  await db.delete(schema.user).where(inArray(schema.user.id, [ids.marina, ids.rafael, ids.tiago]));
  await db.insert(schema.user).values([
    { id: ids.marina, name: "Marina Souza", email: "marina@troom.test", status: "approved" },
    { id: ids.rafael, name: "Rafael Lima", email: "rafael@troom.test", status: "approved" },
    { id: ids.tiago, name: "Tiago Kato", email: "tiago@troom.test", status: "approved" },
  ]);
  await db.insert(schema.agents).values([
    { id: ids.ledger, ownerId: ids.marina, name: "Ledger", role: "invoices", look, tokenHash: "hash_troom_ledger", tools } as never,
    { id: ids.penny, ownerId: ids.tiago, name: "Penny", look, tokenHash: "hash_troom_penny", tools } as never,
    { id: ids.mine, ownerId: ids.marina, name: "Scout", look, tokenHash: "hash_troom_mine", tools } as never,
  ]);
  const store = await import("./teams-store");
  const created = await store.createTeam(ids.marina, { name: "Finance" });
  teamId = created.ok ? created.id : "";
  await store.addMember(teamId, ids.marina, "rafael@troom.test", "member");
  await store.addMember(teamId, ids.marina, "tiago@troom.test", "member");
  await store.bringAgent(ids.ledger, ids.marina, teamId, true);
  await store.bringAgent(ids.penny, ids.tiago, teamId, false);
});

beforeEach(async () => {
  if (!url) return;
  const { getDb, schema } = await import("@/lib/db");
  await getDb().delete(schema.rooms).where(eq(schema.rooms.ownerId, ids.marina));
});

after(async () => {
  if (!url) return;
  const { getDb, schema, getPool } = await import("@/lib/db");
  await getDb().delete(schema.teams).where(eq(schema.teams.createdBy, ids.marina));
  await getDb().delete(schema.user).where(inArray(schema.user.id, [ids.marina, ids.rafael, ids.tiago]));
  await getPool().end();
});

async function openChat(people: string[] = [ids.rafael]) {
  const { createTeamRoom } = await import("./room-store");
  const created = await createTeamRoom(ids.marina, { teamId, name: "october-close", agentIds: [ids.ledger, ids.penny], peopleIds: people });
  assert.ok(created.ok);
  return created.ok ? created.id : "";
}

test("a team group takes only the team's understudies and its people", { skip }, async () => {
  const { createTeamRoom } = await import("./room-store");
  const { roomFor } = await import("./hub/rooms");
  assert.equal((await createTeamRoom(ids.marina, { teamId, name: "x", agentIds: [ids.mine], peopleIds: [] })).ok, false);
  assert.equal((await createTeamRoom("usr_nobody", { teamId, name: "x", agentIds: [ids.ledger], peopleIds: [] })).ok, false);
  const roomId = await openChat();
  assert.ok(await roomFor(roomId, ids.rafael));
  assert.equal(await roomFor(roomId, ids.tiago), null);
});

test("in a team group only a named understudy wakes, working for whoever named it", { skip }, async () => {
  const { Rooms } = await import("./hub/rooms");
  const hub = fakeHub();
  const rooms = new Rooms(hub as never);
  const roomId = await openChat();
  await rooms.personSaid(roomId, ids.rafael, "morning everyone, coffee?");
  assert.equal(hub.delivered.length, 0);
  await rooms.personSaid(roomId, ids.tiago, "@Ledger hello");
  assert.equal(hub.delivered.length, 0);
  await rooms.personSaid(roomId, ids.rafael, "@Ledger which schools in the North are open?");
  assert.deepEqual(hub.delivered.map((d) => [d.agentId, d.message.askedBy]), [[ids.ledger, ids.rafael]]);
  const prompt = hub.delivered[0].message.prompt ?? "";
  assert.match(prompt, /TEAM GROUP CHAT "october-close" of the Finance team/);
  assert.match(prompt, /You are working for Rafael Lima in this turn/);
  assert.match(prompt, /Rafael Lima: "@Ledger which schools/);
  await rooms.agentSaid(ids.ledger, roomId, "@Penny can you draft the reminders?");
  assert.deepEqual(hub.delivered.at(-1)?.agentId, ids.penny);
  assert.equal(hub.delivered.at(-1)?.message.askedBy, ids.rafael);
});

test("an approval raised in a group turn shows up in the group for everyone, bound to the asker", { skip }, async () => {
  const { getDb, schema } = await import("@/lib/db");
  const { Rooms } = await import("./hub/rooms");
  const hub = fakeHub();
  const rooms = new Rooms(hub as never);
  const roomId = await openChat();
  await rooms.personSaid(roomId, ids.rafael, "@Penny send the reminders");
  await rooms.approvalRaised(ids.penny, "apr_troom_1", "Send 3 emails", ids.rafael);
  await rooms.approvalRaised(ids.penny, "apr_troom_2", "Somebody else's", ids.marina);
  const rows = await getDb().select().from(schema.roomMessages).where(eq(schema.roomMessages.roomId, roomId));
  const approval = rows.filter((row) => row.approvalId);
  assert.deepEqual(approval.map((row) => [row.approvalId, row.userId, row.text]), [["apr_troom_1", ids.rafael, "Send 3 emails"]]);
});

test("leaving the team takes a person out of its groups", { skip }, async () => {
  const { roomFor } = await import("./hub/rooms");
  const store = await import("./teams-store");
  const roomId = await openChat([ids.rafael, ids.tiago]);
  assert.ok(await roomFor(roomId, ids.tiago));
  assert.ok((await store.removeMember(teamId, ids.tiago, ids.tiago)).ok);
  assert.equal(await roomFor(roomId, ids.tiago), null);
  const { getDb, schema } = await import("@/lib/db");
  const left = await getDb().select().from(schema.roomParticipants).where(eq(schema.roomParticipants.roomId, roomId));
  assert.deepEqual(left.map((row) => row.agentId), [ids.ledger]);
});
