import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { inArray } from "drizzle-orm";
import type { PushPayload } from "./push";

const url = process.env.TEST_DATABASE_URL;
const skip = !url && "set TEST_DATABASE_URL to a disposable Postgres to run";

if (url) process.env.DATABASE_URL = url;

const ids = { owner: "usr_alert_owner", agent: "agt_alert", recipe: "rcp_alert" };

async function cleanup() {
  const { getDb, schema } = await import("@/lib/db");
  await getDb().delete(schema.user).where(inArray(schema.user.id, [ids.owner]));
}

before(async () => {
  if (!url) return;
  const { getDb, schema } = await import("@/lib/db");
  const db = getDb();
  await (await import("./test-db")).migrateTestDb();
  await cleanup();
  await db.insert(schema.user).values({ id: ids.owner, name: "Owner", email: "owner@alert.local", status: "approved" });
  const look = { body: "pill", color: "#7FB2FF", eyes: "dot", acc: "none", accColor: "#2F3A56" };
  await db.insert(schema.agents).values({ id: ids.agent, ownerId: ids.owner, name: "Coach", look, tokenHash: "hash_alert", tools: { notifyOwner: true, slack: false, slackChannels: [] }, brains: [{ brain: "claude", loggedIn: true }] } as never);
  await db.insert(schema.recipes).values({ id: ids.recipe, agentId: ids.agent, recipe: { title: "Weekly review", trigger: "x", steps: [], questions: [], askFirstRuns: 0 }, active: true } as never);
  const at = (minutes: number) => new Date(Date.now() - (10 - minutes) * 60_000);
  await db.insert(schema.runs).values([
    { id: "run_alert_1", agentId: ids.agent, recipeId: ids.recipe, trigger: "schedule", status: "ok", summary: "fine", startedAt: at(1) },
    { id: "run_alert_2", agentId: ids.agent, recipeId: ids.recipe, trigger: "schedule", status: "failed", summary: "broke", startedAt: at(2) },
    { id: "run_alert_3", agentId: ids.agent, recipeId: ids.recipe, trigger: "test", status: "failed", summary: "test broke", startedAt: at(3) },
    { id: "run_alert_4", agentId: ids.agent, recipeId: ids.recipe, trigger: "schedule", status: "failed", summary: "broke again", startedAt: at(4) },
  ]);
});

after(async () => {
  if (!url) return;
  await cleanup();
  const { getPool } = await import("@/lib/db");
  await getPool().end();
});

function fakeDeps() {
  const pushes: PushPayload[] = [];
  const dms: Array<{ key: string; text: string }> = [];
  return {
    pushes,
    dms,
    deps: {
      push: async (_ids: string[], payload: PushPayload) => void pushes.push(payload),
      slackUser: async () => "U1",
      replace: async (_userId: string, key: string, text: string) => (dms.push({ key, text }), { ok: true }),
      baseUrl: "https://panel.example.com",
    },
  };
}

test("a failed scheduled run tells the owner once, counting the failures in a row", { skip }, async () => {
  const { notifyRunFailure } = await import("./run-alerts");
  const { deps, pushes, dms } = fakeDeps();
  await notifyRunFailure(ids.agent, "run_alert_4", undefined, deps);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].title, "Coach failed 2 times in a row");
  assert.equal(pushes[0].url, "/runs/run_alert_4");
  assert.equal(dms.length, 1);
  assert.equal(dms[0].key, `${ids.agent}:${ids.recipe}`);
  assert.match(dms[0].text, /Coach could not finish "Weekly review"/);
});

test("a run the owner stopped, a test run and a signed-out brain are handled", { skip }, async () => {
  const { notifyRunFailure } = await import("./run-alerts");
  const stopped = fakeDeps();
  await notifyRunFailure(ids.agent, "run_alert_4", "stopped", stopped.deps);
  assert.equal(stopped.pushes.length + stopped.dms.length, 0);
  const testRun = fakeDeps();
  await notifyRunFailure(ids.agent, "run_alert_3", undefined, testRun.deps);
  assert.equal(testRun.pushes.length + testRun.dms.length, 0);
  const signedOut = fakeDeps();
  await notifyRunFailure(ids.agent, "run_alert_4", "signed_out", signedOut.deps);
  assert.equal(signedOut.pushes[0].url, `/agents/${ids.agent}?tab=settings`);
  assert.match(signedOut.dms[0].text, /Connect Claude again/);
});

test("the waiting list shows the task that keeps failing", { skip }, async () => {
  const { loadOpenFailures } = await import("./run-alerts");
  const open = await loadOpenFailures([ids.agent]);
  assert.equal(open.length, 1);
  assert.equal(open[0].latest.runId, "run_alert_4");
  assert.equal(open[0].streak, 2);
});
