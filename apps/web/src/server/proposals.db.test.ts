import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { eq, inArray } from "drizzle-orm";
import type { Recipe } from "@understudy/protocol";

const url = process.env.TEST_DATABASE_URL;
const skip = !url && "set TEST_DATABASE_URL to a disposable Postgres to run";

if (url) process.env.DATABASE_URL = url;
process.env.UNDERSTUDY_PUBLIC_URL = "https://understudy.example.test";

const ids = { owner: "usr_prop_owner", other: "usr_prop_other", agent: "agt_prop_mine" };

const invoices: Recipe = {
  title: "Export open Northwind invoices",
  trigger: "every Monday morning",
  steps: [
    { id: "s1", text: "Open the Northwind billing site and filter open invoices", mode: "auto" },
    { id: "s2", text: "Send the spreadsheet to finance", mode: "ask" },
  ],
  questions: [],
  askFirstRuns: 3,
};

const lunch: Recipe = {
  title: "Order the team lunch",
  trigger: "every Friday",
  steps: [
    { id: "s1", text: "Collect lunch choices from the team thread", mode: "auto" },
    { id: "s2", text: "Place the catering order", mode: "ask" },
  ],
  questions: [{ id: "q1", text: "How many people?", options: [] }],
  askFirstRuns: 3,
};

const proposal = (recipe: Recipe, cron: string | null = "0 9 * * 1") => ({ recipe, cron, timezone: "UTC", reason: "You asked me for this three times this month.", origin: "repeated" as const });

before(async () => {
  if (!url) return;
  const { getDb, schema } = await import("@/lib/db");
  const db = getDb();
  await (await import("./test-db")).migrateTestDb();
  await db.delete(schema.user).where(inArray(schema.user.id, [ids.owner, ids.other]));
  await db.insert(schema.user).values([
    { id: ids.owner, name: "Maya", email: "prop-owner@test.local", status: "approved" },
    { id: ids.other, name: "Sam", email: "prop-other@test.local", status: "approved" },
  ]);
  const tools = { notifyOwner: true, slack: false, slackChannels: [] };
  const look = { body: "pill", color: "#7FB2FF", eyes: "dot", acc: "none", accColor: "#2F3A56" };
  await db.insert(schema.agents).values({ id: ids.agent, ownerId: ids.owner, name: "Ada", look, tokenHash: "hash_prop_mine", tools } as never);
});

beforeEach(async () => {
  if (!url) return;
  const { getDb, schema } = await import("@/lib/db");
  const db = getDb();
  await db.delete(schema.taskProposals).where(eq(schema.taskProposals.agentId, ids.agent));
  await db.delete(schema.recipes).where(eq(schema.recipes.agentId, ids.agent));
  await db.delete(schema.messages).where(eq(schema.messages.agentId, ids.agent));
});

after(async () => {
  if (!url) return;
  const { getDb, schema, getPool } = await import("@/lib/db");
  await getDb().delete(schema.user).where(inArray(schema.user.id, [ids.owner, ids.other]));
  await getPool().end();
});

async function newHub() {
  const { Hub } = await import("./hub");
  const hub = new Hub();
  const broadcasts: { type: string }[] = [];
  hub.broadcast = ((_agentId: string, message: { type: string }) => broadcasts.push(message)) as typeof hub.broadcast;
  hub.broadcastCard = ((_agentId: string, message: { type: string }) => broadcasts.push(message)) as typeof hub.broadcastCard;
  return { hub, broadcasts };
}

test("a proposal lands in the chat as a card and is not a task until the owner saves it", { skip }, async () => {
  const { getDb, schema } = await import("@/lib/db");
  const { loadChat } = await import("@/lib/views");
  const { hub } = await newHub();
  const result = await hub.proposals.propose(ids.agent, proposal(invoices));
  assert.ok(result.ok);
  assert.equal(result.replaced, false);
  assert.equal((await getDb().select().from(schema.recipes).where(eq(schema.recipes.agentId, ids.agent))).length, 0);
  const chat = await loadChat(ids.agent);
  assert.equal(chat.length, 1);
  assert.equal(chat[0].role, "agent");
  assert.equal(chat[0].proposal?.id, result.id);
  assert.equal(chat[0].proposal?.status, "pending");
  assert.equal(chat[0].proposal?.recipe.steps[1].mode, "ask");
});

test("proposing the same routine again updates the waiting card instead of adding one", { skip }, async () => {
  const { loadChat } = await import("@/lib/views");
  const { hub, broadcasts } = await newHub();
  const first = await hub.proposals.propose(ids.agent, proposal(invoices));
  const again = await hub.proposals.propose(ids.agent, { ...proposal({ ...invoices, title: "Northwind open invoices export" }), reason: "Fourth time this month." });
  assert.ok(first.ok && again.ok);
  assert.equal(again.id, first.id);
  assert.equal(again.replaced, true);
  const chat = await loadChat(ids.agent);
  assert.equal(chat.length, 1);
  assert.equal(chat[0].proposal?.reason, "Fourth time this month.");
  assert.ok(broadcasts.some((message) => message.type === "proposal"));
});

test("saving creates the task on the suggested schedule, once", { skip }, async () => {
  const { getDb, schema } = await import("@/lib/db");
  const { hub } = await newHub();
  const result = await hub.proposals.propose(ids.agent, proposal(invoices));
  assert.ok(result.ok);
  const saved = await hub.proposals.answer(result.id, true, ids.owner);
  assert.equal(saved?.status, "saved");
  const [recipe] = await getDb().select().from(schema.recipes).where(eq(schema.recipes.agentId, ids.agent));
  assert.equal(recipe.id, saved?.recipeId);
  assert.equal(recipe.recipe.title, invoices.title);
  assert.equal(recipe.cron, "0 9 * * 1");
  assert.equal(recipe.active, true);
  assert.equal(recipe.recipe.askFirstRuns, 3);
  const notes = await getDb().select().from(schema.messages).where(eq(schema.messages.agentId, ids.agent));
  assert.ok(notes.some((m) => m.role === "system" && m.text.includes(`/agents/${ids.agent}/recipes/${recipe.id}`)));
  assert.equal(await hub.proposals.answer(result.id, true, ids.owner), null);
  assert.equal((await getDb().select().from(schema.recipes).where(eq(schema.recipes.agentId, ids.agent))).length, 1);
});

test("save and edit keeps the new task paused for review", { skip }, async () => {
  const { getDb, schema } = await import("@/lib/db");
  const { hub } = await newHub();
  const result = await hub.proposals.propose(ids.agent, proposal(invoices));
  assert.ok(result.ok);
  await hub.proposals.answer(result.id, true, ids.owner, { keepPaused: true });
  const [recipe] = await getDb().select().from(schema.recipes).where(eq(schema.recipes.agentId, ids.agent));
  assert.equal(recipe.active, false);
  assert.equal(recipe.cron, "0 9 * * 1");
});

test("a task proposed without a schedule is saved to run when asked", { skip }, async () => {
  const { getDb, schema } = await import("@/lib/db");
  const { hub } = await newHub();
  const result = await hub.proposals.propose(ids.agent, proposal(lunch, null));
  assert.ok(result.ok);
  await hub.proposals.answer(result.id, true, ids.owner);
  const [recipe] = await getDb().select().from(schema.recipes).where(eq(schema.recipes.agentId, ids.agent));
  assert.equal(recipe.cron, null);
  assert.equal(recipe.active, false);
});

test("after not now, the same routine is not proposed again, and a routine that is already a task is refused", { skip }, async () => {
  const { hub } = await newHub();
  const result = await hub.proposals.propose(ids.agent, proposal(invoices));
  assert.ok(result.ok);
  const dismissed = await hub.proposals.answer(result.id, false, ids.owner);
  assert.equal(dismissed?.status, "dismissed");
  const again = await hub.proposals.propose(ids.agent, proposal({ ...invoices, title: "Export the open Northwind invoices" }));
  assert.equal(again.ok, false);
  assert.equal(!again.ok && again.reason, "dismissed");
  const other = await hub.proposals.propose(ids.agent, proposal(lunch));
  assert.ok(other.ok);
  await hub.proposals.answer(other.id, true, ids.owner);
  const twice = await hub.proposals.propose(ids.agent, proposal(lunch));
  assert.equal(!twice.ok && twice.reason, "exists");
});

test("only a few suggestions wait at once", { skip }, async () => {
  const { hub } = await newHub();
  const { MAX_PENDING_PROPOSALS } = await import("./hub/proposals");
  const topics = [
    ["Renew supplier contracts", "Compare vendor quotes", "Draft renewal letters"],
    ["Count warehouse stock", "Scan pallet barcodes", "Reconcile inventory ledger"],
    ["Review newsletter draft", "Proofread headline copy", "Schedule mailing campaign"],
    ["Book conference travel", "Search flight fares", "Reserve hotel rooms"],
  ];
  const results = [];
  for (const [title, first, second] of topics.slice(0, MAX_PENDING_PROPOSALS + 1)) {
    results.push(await hub.proposals.propose(ids.agent, proposal({ title, trigger: "when asked", steps: [{ id: "s1", text: first, mode: "auto" }, { id: "s2", text: second, mode: "auto" }], questions: [], askFirstRuns: 3 })));
  }
  assert.deepEqual(results.map((r) => r.ok), [...Array(MAX_PENDING_PROPOSALS).fill(true), false]);
  const last = results[results.length - 1];
  assert.equal(!last.ok && last.reason, "too_many");
});

test("the third similar ask from the owner is flagged, unless a task already covers it", { skip }, async () => {
  const { getDb, schema } = await import("@/lib/db");
  const { newId } = await import("@/lib/ids");
  const { hub } = await newHub();
  const day = 86_400_000;
  const ask = "Summarize the support inbox and list urgent tickets by customer";
  await getDb().insert(schema.messages).values([
    { id: newId("msg"), agentId: ids.agent, role: "user", text: ask, authorId: ids.owner, createdAt: new Date(Date.now() - 6 * day) },
    { id: newId("msg"), agentId: ids.agent, role: "user", text: "summarize the support inbox, urgent tickets by customer", authorId: ids.owner, createdAt: new Date(Date.now() - 2 * day) },
    { id: newId("msg"), agentId: ids.agent, role: "user", text: ask, authorId: ids.other, createdAt: new Date(Date.now() - 4 * day) },
  ]);
  const current = await hub.addMessage(ids.agent, "user", ask, null, ids.owner);
  const repeat = await hub.proposals.repeatOf(ids.agent, ids.owner, ask, current);
  assert.equal(repeat?.times, 3);
  assert.equal(await hub.proposals.repeatOf(ids.agent, ids.other, ask, current), null);
  const covering: Recipe = { title: "Support inbox summary", trigger: "every morning", steps: [{ id: "s1", text: "List urgent tickets by customer", mode: "auto" }], questions: [], askFirstRuns: 3 };
  await getDb().insert(schema.recipes).values({ id: newId("rcp"), agentId: ids.agent, recipe: covering });
  assert.equal(await hub.proposals.repeatOf(ids.agent, ids.owner, ask, current), null);
});
