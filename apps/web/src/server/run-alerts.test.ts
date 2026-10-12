import assert from "node:assert/strict";
import { test } from "node:test";
import { deliverRunFailureNotice, failureStreak, openFailures, runFailurePush, runFailureSlackText, type FailureRow, type NoticeDeps, type RunFailureNotice } from "./run-alerts";
import { replaceDirectNotice, RUN_NOTICE_EVENT, type NoticeApi } from "./slack";

const notice: RunFailureNotice = {
  key: "agt_1:rcp_1",
  agentId: "agt_1",
  agentName: "Coach",
  brain: "claude",
  task: "Weekly workout review",
  summary: "The site <did not> load",
  runId: "run_9",
  streak: 1,
  signedOut: false,
};

const owner = { id: "usr_1", email: "owner@example.com" };

test("the failure streak counts failures until the last run that worked", () => {
  assert.equal(failureStreak([]), 0);
  assert.equal(failureStreak(["ok", "failed"]), 0);
  assert.equal(failureStreak(["failed", "failed", "ok", "failed"]), 2);
  assert.equal(failureStreak(["failed", "failed", "failed"]), 3);
});

test("a first failure links to the run and quotes what happened", () => {
  const text = runFailureSlackText(notice, "https://panel.example.com");
  assert.match(text, /Coach could not finish "Weekly workout review"/);
  assert.match(text, /> The site &lt;did not&gt; load/);
  assert.match(text, /<https:\/\/panel\.example\.com\/runs\/run_9\|See what happened>/);
  assert.doesNotMatch(text, /in a row/);
});

test("a signed-out brain asks the owner to connect it again with a link to the agent's settings", () => {
  const text = runFailureSlackText({ ...notice, signedOut: true, streak: 3 }, "https://panel.example.com");
  assert.match(text, /It failed 3 times in a row/);
  assert.match(text, /Claude is signed out on this computer/);
  assert.match(text, /<https:\/\/panel\.example\.com\/agents\/agt_1\?tab=settings\|Connect Claude again>/);
  const push = runFailurePush({ ...notice, signedOut: true, streak: 3 });
  assert.equal(push.url, "/agents/agt_1?tab=settings");
  assert.equal(push.title, "Coach failed 3 times in a row");
});

test("push notices for the same recurring failure share one tag so they replace each other", () => {
  assert.equal(runFailurePush({ ...notice, runId: "run_1" }).tag, runFailurePush({ ...notice, runId: "run_2", streak: 2 }).tag);
  assert.notEqual(runFailurePush(notice).tag, runFailurePush({ ...notice, key: "agt_1:rcp_2" }).tag);
});

function fakeDeps(slackUser: string | null) {
  const pushes: unknown[] = [];
  const dms: Array<{ userId: string; key: string; text: string }> = [];
  const deps: NoticeDeps = {
    push: async (_ids, payload) => void pushes.push(payload),
    slackUser: async () => slackUser,
    replace: async (userId, key, text) => (dms.push({ userId, key, text }), { ok: true }),
    baseUrl: "https://panel.example.com",
  };
  return { deps, pushes, dms };
}

test("the owner gets a Slack DM when their Slack account is found, even with no conversation open", async () => {
  const { deps, pushes, dms } = fakeDeps("U123");
  assert.deepEqual(await deliverRunFailureNotice(notice, owner, deps), { slack: true });
  assert.equal(pushes.length, 1);
  assert.equal(dms.length, 1);
  assert.equal(dms[0].userId, "U123");
  assert.equal(dms[0].key, "agt_1:rcp_1");
});

test("without a Slack account the notice still goes to push and nothing breaks", async () => {
  const { deps, pushes, dms } = fakeDeps(null);
  assert.deepEqual(await deliverRunFailureNotice(notice, owner, deps), { slack: false });
  assert.equal(pushes.length, 1);
  assert.equal(dms.length, 0);
});

function fakeSlack(history: Array<{ ts: string; metadata?: { event_type?: string; event_payload?: Record<string, unknown> } }>) {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const api: NoticeApi = {
    call: async (method, body) => {
      calls.push({ method, body });
      if (method === "conversations.open") return { ok: true, channel: { id: "D1" } };
      return { ok: true, ts: "9.9" };
    },
    get: async () => ({ ok: true, messages: history }),
  };
  return { api, calls };
}

test("a repeat of the same failure replaces the earlier DM instead of piling up", async () => {
  const { api, calls } = fakeSlack([
    { ts: "1.1", metadata: { event_type: RUN_NOTICE_EVENT, event_payload: { key: "agt_1:rcp_2" } } },
    { ts: "2.2", metadata: { event_type: RUN_NOTICE_EVENT, event_payload: { key: "agt_1:rcp_1" } } },
    { ts: "3.3" },
  ]);
  const result = await replaceDirectNotice("U123", "agt_1:rcp_1", "failed again", undefined, api);
  assert.deepEqual(result, { ok: true, error: undefined, replaced: true });
  assert.deepEqual(
    calls.map((call) => call.method),
    ["conversations.open", "chat.delete", "chat.postMessage"],
  );
  assert.deepEqual(calls[1].body, { channel: "D1", ts: "2.2" });
  assert.deepEqual(calls[2].body.metadata, { event_type: RUN_NOTICE_EVENT, event_payload: { key: "agt_1:rcp_1" } });
});

test("a first failure posts a new DM and deletes nothing", async () => {
  const { api, calls } = fakeSlack([{ ts: "1.1", metadata: { event_type: RUN_NOTICE_EVENT, event_payload: { key: "agt_1:rcp_2" } } }]);
  const result = await replaceDirectNotice("U123", "agt_1:rcp_1", "failed", undefined, api);
  assert.equal(result.replaced, false);
  assert.deepEqual(
    calls.map((call) => call.method),
    ["conversations.open", "chat.postMessage"],
  );
});

function row(recipeId: string, status: string, runId: string, loggedIn = true): FailureRow {
  return { runId, recipeId, status, summary: "x", finishedAt: new Date(0), task: recipeId, agent: { id: "agt_1", name: "Coach", look: {}, brain: "claude", brains: [{ brain: "claude", loggedIn }] } };
}

test("the waiting list shows one entry per task that is still failing, with its count", () => {
  const open = openFailures([row("rcp_a", "failed", "r3"), row("rcp_b", "ok", "r5"), row("rcp_a", "failed", "r2"), row("rcp_b", "failed", "r4"), row("rcp_a", "ok", "r1")]);
  assert.equal(open.length, 1);
  assert.equal(open[0].latest.runId, "r3");
  assert.equal(open[0].streak, 2);
  assert.equal(open[0].signedOut, false);
  assert.equal(openFailures([row("rcp_a", "failed", "r1", false)])[0].signedOut, true);
});
