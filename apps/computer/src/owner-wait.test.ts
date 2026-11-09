import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ComputerToServer } from "@understudy/protocol";
import { createAgent, PANEL_CLOSED_SUMMARY, RESTARTED_SUMMARY, waitForOwnerAnswers, type RunApprovalsLookup } from "./agent.ts";
import { askInRun, askOwnerFor, askStoreFile, openAskStore, pendingText } from "./approval-asks.ts";
import type { BrainEvent, TurnRequest } from "./brain.ts";
import { listRunApprovals, type McpSession, type RunApprovalList } from "./gatekeeper-client.ts";
import { createMemory } from "./memory.ts";
import { ownerAnsweredPrompt, runPrompt } from "./recipe.ts";

type Planned = { events: BrainEvent[]; result: { ok: boolean; text: string; sessionId: string | null } };

const recipe = { title: "Board update", trigger: "x", steps: [{ id: "s1", text: "Collect the cards", mode: "auto" as const }, { id: "s2", text: "Send the board update", mode: "ask" as const }], questions: [], askFirstRuns: 3 };

const pendingReply = JSON.stringify({ status: "pending", requestId: "apr_board", note: "your owner has not answered yet" });

const gaveUp: Planned = {
  events: [
    { kind: "tool", name: "mcp__gatekeeper__request_approval", input: { summary: "Send the board update", runId: "run_board", stepId: "s2" } },
    { kind: "tool_result", name: "mcp__gatekeeper__request_approval", isError: false, text: pendingReply },
    { kind: "text", text: 'RESULT {"ok": false, "summary": "Approval request for step s2 got no answer and timed out after 1800s"}' },
  ],
  result: { ok: true, text: 'RESULT {"ok": false, "summary": "Approval request for step s2 got no answer and timed out after 1800s"}', sessionId: "session-1" },
};

function harness(script: (request: TurnRequest, index: number) => Planned | Promise<Planned>, runApprovals?: RunApprovalsLookup, home = mkdtempSync(join(tmpdir(), "understudy-wait-"))) {
  const requests: TurnRequest[] = [];
  const sent: ComputerToServer[] = [];
  const runTurn = (_config: unknown, request: TurnRequest) => {
    requests.push(request);
    let cancel = () => {};
    const cancelled = new Promise<Planned>((resolve) => (cancel = () => resolve({ events: [], result: { ok: false, text: "", sessionId: request.resume ?? null } })));
    const done = Promise.race([Promise.resolve(script(request, requests.length - 1)), cancelled]).then((planned) => {
      for (const event of planned.events) request.onEvent(event);
      return planned.result;
    });
    return { done, cancel: () => cancel() };
  };
  const agent = createAgent({
    config: { home, workDir: join(home, "work"), serverUrl: "http://x", token: "t" },
    memory: createMemory(home),
    settingsFile: join(home, ".understudy", "settings.json"),
    send: (message) => (sent.push(message), true),
    runTurn: runTurn as never,
    runApprovals,
    ownerWaitRetryMs: 5,
    openRunsFile: join(home, ".understudy", "open-runs.json"),
  });
  return { agent, requests, sent, home };
}

async function until(check: () => boolean, label: string) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
}

function ownerDesk() {
  const asks = new Map<string, { summary: string; stepId: string; status: string; note?: string }>();
  let answered: () => void = () => {};
  let answer = new Promise<void>((resolve) => (answered = resolve));
  const calls: { wait: boolean }[] = [];
  const lookup: RunApprovalsLookup = async (_runId, wait, signal) => {
    calls.push({ wait });
    const list = (): RunApprovalList => ({
      pending: [...asks].filter(([, ask]) => ask.status === "pending").map(([requestId, ask]) => ({ requestId, summary: ask.summary, stepId: ask.stepId })),
      answered: [...asks].filter(([, ask]) => ask.status !== "pending").map(([requestId, ask]) => ({ requestId, summary: ask.summary, stepId: ask.stepId, status: ask.status, ...(ask.note ? { note: ask.note } : {}) })),
    });
    if (wait && list().pending.length) await Promise.race([answer, new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))]);
    return list();
  };
  return {
    lookup,
    calls,
    ask(requestId: string, summary: string, stepId: string) {
      asks.set(requestId, { summary, stepId, status: "pending" });
    },
    answer(requestId: string, status: string, note?: string) {
      asks.set(requestId, { ...asks.get(requestId)!, status, note });
      answered();
      answer = new Promise<void>((resolve) => (answered = resolve));
    },
  };
}

test("a run whose model gives up on a pending approval stays open until the owner answers, then carries on in the same session", async () => {
  const desk = ownerDesk();
  desk.ask("apr_board", "Send the board update", "s2");
  const { agent, requests, sent } = harness((request, index) => {
    if (index === 0) return gaveUp;
    return { events: [{ kind: "text", text: 'Sent.\nRESULT {"ok": true, "summary": "Sent the board update"}' }], result: { ok: true, text: 'RESULT {"ok": true, "summary": "Sent the board update"}', sessionId: "session-1" } };
  }, desk.lookup);
  agent.enqueue({ kind: "run", runId: "run_board", recipe, approvalsRequired: true });
  await until(() => agent.state() === "waiting_you" && desk.calls.some((call) => call.wait), "the run to wait for the owner");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(requests.length, 1);
  assert.equal(sent.some((message) => message.type === "run_finished"), false);
  assert.ok(sent.some((message) => message.type === "activity" && /Waiting for your answer: Send the board update/.test((message as { text: string }).text)));

  desk.answer("apr_board", "approved");
  await until(() => sent.some((message) => message.type === "run_finished"), "the run to finish");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].resume, "session-1");
  assert.match(requests[1].prompt, /"Send the board update" \(step s2\) \[requestId: apr_board\]: approved/);
  assert.deepEqual(sent.find((message) => message.type === "run_finished"), { type: "run_finished", runId: "run_board", ok: true, summary: "Sent the board update" });
});

test("a denied or expired answer resumes the run too, and the model is told it is not a yes", async () => {
  const desk = ownerDesk();
  desk.ask("apr_board", "Send the board update", "s2");
  const { agent, requests, sent } = harness((_request, index) =>
    index === 0 ? gaveUp : { events: [], result: { ok: true, text: 'RESULT {"ok": false, "summary": "Skipped the board update: the request expired"}', sessionId: "session-1" } },
  desk.lookup);
  agent.enqueue({ kind: "run", runId: "run_board", recipe, approvalsRequired: true });
  await until(() => desk.calls.some((call) => call.wait), "the wait");
  desk.answer("apr_board", "expired");
  await until(() => sent.some((message) => message.type === "run_finished"), "the run to finish");
  assert.match(requests[1].prompt, /: expired[\s\S]*Denied, expired or cancelled is not a yes/);
  assert.deepEqual(sent.find((message) => message.type === "run_finished"), { type: "run_finished", runId: "run_board", ok: false, summary: "Skipped the board update: the request expired" });
});

test("a run with nothing pending ends as before, after one look at its approvals", async () => {
  const desk = ownerDesk();
  const { agent, requests, sent } = harness(() => ({ events: [], result: { ok: true, text: 'RESULT {"ok": true, "summary": "Read 150 posts"}', sessionId: "session-2" } }), desk.lookup);
  agent.enqueue({ kind: "run", runId: "run_feed", recipe, approvalsRequired: true });
  await until(() => sent.some((message) => message.type === "run_finished"), "the run to finish");
  assert.equal(requests.length, 1);
  assert.deepEqual(desk.calls, [{ wait: false }]);
});

test("the panel stops a stalled run: the turn is cancelled and the run ends with the panel's reason", async () => {
  let started = false;
  const { agent, sent } = harness(() => {
    started = true;
    return new Promise<Planned>(() => {});
  });
  agent.enqueue({ kind: "run", runId: "run_stuck", recipe, approvalsRequired: false });
  agent.enqueue({ kind: "run", runId: "run_next", recipe, approvalsRequired: false });
  await until(() => started, "the turn to start");
  agent.stopRun("run_other", "not this one");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sent.some((message) => message.type === "run_finished"), false);
  agent.stopRun("run_next", "queued run closed by the panel");
  agent.stopRun("run_stuck", "No activity for 35 minutes");
  await until(() => sent.some((message) => message.type === "run_finished"), "the run to finish");
  assert.deepEqual(sent.find((message) => message.type === "run_finished"), { type: "run_finished", runId: "run_stuck", ok: false, summary: "No activity for 35 minutes", outcome: "stopped" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(sent.filter((message) => message.type === "run_finished").length, 1);
  assert.equal(agent.state(), "stuck");
});

test("the panel can stop a run while it waits for the owner", async () => {
  const desk = ownerDesk();
  desk.ask("apr_board", "Send the board update", "s2");
  const { agent, sent } = harness(() => gaveUp, desk.lookup);
  agent.enqueue({ kind: "run", runId: "run_board", recipe, approvalsRequired: true });
  await until(() => desk.calls.some((call) => call.wait), "the wait");
  agent.stop();
  await until(() => sent.some((message) => message.type === "run_finished"), "the run to finish");
  assert.deepEqual(sent.find((message) => message.type === "run_finished"), { type: "run_finished", runId: "run_board", ok: false, summary: "Stopped by the owner.", outcome: "stopped" });
});

test("waiting for the owner survives a panel that cannot be reached for a while, even right when the turn ends", async () => {
  let looks = 0;
  const pending = { requestId: "apr_1", summary: "Pay the invoice", stepId: "s2" };
  const waited = await waitForOwnerAnswers(
    async (wait) => {
      looks += 1;
      if (looks <= 3) throw new Error("gatekeeper answered HTTP 502");
      if (!wait) return { pending: [pending], answered: [] };
      if (looks < 7) throw new Error("fetch failed");
      return { pending: [], answered: [{ ...pending, status: "approved" }] };
    },
    { stopped: () => false, pause: async () => {}, onWaiting: () => {} },
  );
  assert.deepEqual(waited, { answers: [{ ...pending, status: "approved" }], closed: false });
  assert.equal(looks, 7);

  const olderPanel = { call: async () => "unknown tool run_approvals" };
  assert.deepEqual(await listRunApprovals(olderPanel, "run_board", false), { pending: [], answered: [] });
  assert.deepEqual(await listRunApprovals({ call: async () => JSON.stringify({ runId: "run_board", pending: [], answered: [], open: false }) }, "run_board", false), { pending: [], answered: [], open: false });
  await assert.rejects(listRunApprovals({ call: async () => "<html>bad gateway</html>" }, "run_board", true), /did not list the run's approvals/);

  let clock = 0;
  const forever = await waitForOwnerAnswers(async () => ({ pending: [pending], answered: [] }), { stopped: () => false, pause: async () => {}, onWaiting: () => {}, now: () => (clock += 1000), maxMs: 5000 });
  assert.deepEqual(forever, { answers: [], closed: false });
  clock = 0;
  const pauses: number[] = [];
  const unreachable = await waitForOwnerAnswers(
    async () => {
      throw new Error("down");
    },
    { stopped: () => false, pause: async (ms) => void pauses.push(ms), onWaiting: () => assert.fail("nothing is known to wait"), now: () => (clock += 1000), maxMs: 10_000, retryMs: 30_000 },
  );
  assert.deepEqual(unreachable, { answers: [], closed: false });
  assert.ok(pauses.length >= 4 && pauses.every((ms) => ms === 30_000));
  assert.deepEqual(await waitForOwnerAnswers(async () => ({ pending: [pending], answered: [], open: false }), { stopped: () => false, pause: async () => {}, onWaiting: () => {} }), { answers: [], closed: true });
});

test("a computer that restarts while its run waits for the owner picks the wait up again and resumes the same session", async () => {
  const desk = ownerDesk();
  desk.ask("apr_board", "Send the board update", "s2");
  const before = harness((request) => {
    request.onEvent({ kind: "session", sessionId: "session-before" });
    return new Promise<Planned>(() => {});
  }, desk.lookup);
  before.agent.enqueue({ kind: "run", runId: "run_board", recipe, approvalsRequired: true });
  await until(() => before.requests.length === 1, "the first turn");
  await new Promise((resolve) => setTimeout(resolve, 20));

  const after = harness(() => ({ events: [], result: { ok: true, text: 'RESULT {"ok": true, "summary": "Sent the board update"}', sessionId: "session-before" } }), desk.lookup, before.home);
  after.agent.resumeOpenRuns();
  after.agent.resumeOpenRuns();
  await until(() => after.agent.state() === "waiting_you", "the restarted computer to wait");
  assert.equal(after.requests.length, 0);
  assert.ok(after.sent.some((message) => message.type === "activity" && /computer restarted/.test((message as { text: string }).text)));
  desk.answer("apr_board", "approved");
  await until(() => after.sent.some((message) => message.type === "run_finished"), "the run to finish");
  assert.equal(after.requests.length, 1);
  assert.equal(after.requests[0].resume, "session-before");
  assert.match(after.requests[0].prompt, /\[requestId: apr_board\]: approved/);
  assert.deepEqual(after.sent.find((message) => message.type === "run_finished"), { type: "run_finished", runId: "run_board", ok: true, summary: "Sent the board update" });

  const again = harness(() => assert.fail("no turn"), desk.lookup, before.home);
  again.agent.resumeOpenRuns();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(again.sent.length, 0);
});

test("a computer that restarts in the middle of a run with nothing waiting for the owner closes the run and says so", async () => {
  const desk = ownerDesk();
  const before = harness((request) => {
    request.onEvent({ kind: "session", sessionId: "session-before" });
    return new Promise<Planned>(() => {});
  }, desk.lookup);
  before.agent.enqueue({ kind: "run", runId: "run_feed", recipe, approvalsRequired: false });
  await until(() => before.requests.length === 1, "the first turn");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const after = harness(() => assert.fail("no turn"), desk.lookup, before.home);
  after.agent.resumeOpenRuns();
  await until(() => after.sent.some((message) => message.type === "run_finished"), "the run to close");
  assert.deepEqual(after.sent.find((message) => message.type === "run_finished"), { type: "run_finished", runId: "run_feed", ok: false, summary: RESTARTED_SUMMARY });
  assert.match(RESTARTED_SUMMARY, /restarted while this run was in progress, and nothing in it was waiting for your answer/);
  assert.equal(after.agent.state(), "stuck");
});

test("a run the panel already closed stops waiting at once", async () => {
  const lookup: RunApprovalsLookup = async () => ({ pending: [], answered: [], open: false });
  const { agent, sent } = harness(() => gaveUp, lookup);
  agent.enqueue({ kind: "run", runId: "run_board", recipe, approvalsRequired: true });
  await until(() => sent.some((message) => message.type === "run_finished"), "the run to end");
  assert.deepEqual(sent.find((message) => message.type === "run_finished"), { type: "run_finished", runId: "run_board", ok: false, summary: PANEL_CLOSED_SUMMARY, outcome: "stopped" });
});

test("the run prompt tells the model a pending answer means keep waiting, never end or skip", () => {
  const prompt = runPrompt({ runId: "run_board", recipe, approvalsRequired: true });
  assert.doesNotMatch(prompt, /still pending or never came back/);
  assert.match(prompt, /If an answer is pending[\s\S]*Keep waiting[\s\S]*never end the run, report it as failed or skip the item because an answer is pending/);
  assert.match(prompt, /If an answer is denied or expired[\s\S]*skip that item/);
  assert.match(ownerAnsweredPrompt([{ requestId: "apr_1", summary: 'Send "Q3" report', stepId: "s2", status: "denied", note: "not today" }]), /"Send \\"Q3\\" report" \(step s2\) \[requestId: apr_1\]: denied, with the note "not today"/);
});

function fakeGatekeeper(answers: Record<string, (args: Record<string, unknown>) => string>) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const session: McpSession = {
    async call(name, args) {
      calls.push({ name, args });
      const answer = answers[name];
      if (!answer) throw new Error(`unexpected ${name}`);
      return answer(args);
    },
  };
  return { session, calls };
}

test("an ask-first step that is still pending joins the same request when asked again, in this turn or the next", async () => {
  const home = mkdtempSync(join(tmpdir(), "understudy-asks-"));
  const store = openAskStore(askStoreFile(home));
  const request = { runId: "run_board", stepId: "s2", summary: "Send the board update", fields: [{ label: "Step", value: "Send the board update" }] };
  let status = "pending";
  const { session, calls } = fakeGatekeeper({
    request_approval: () => pendingReply,
    run_approvals: () => JSON.stringify({ runId: "run_board", pending: status === "pending" ? [{ requestId: "apr_board", stepId: "s2", summary: "Send the board update" }] : [], answered: status === "pending" ? [] : [{ requestId: "apr_board", stepId: "s2", summary: "Send the board update", status }] }),
    wait_for_approval: (args) => (status === "pending" ? JSON.stringify({ status: "pending", requestId: args.requestId }) : `${status} [requestId: ${args.requestId}]`),
  });
  const first = await askInRun(async () => session, store, request);
  assert.deepEqual({ approved: first.approved, pending: first.pending, requestId: first.requestId }, { approved: false, pending: true, requestId: "apr_board" });
  assert.match(pendingText(request.summary, "call browser_ask_first again with the same stepId, summary and fields", first), /^pending: your owner has not answered "Send the board update" yet, and that is not approval[\s\S]*does not ask your owner a second time[\s\S]*\[requestId: apr_board\]$/);

  const again = await askInRun(async () => session, openAskStore(askStoreFile(home)), request);
  assert.equal(again.pending, true);
  status = "approved";
  const yes = await askInRun(async () => session, openAskStore(askStoreFile(home)), request);
  assert.equal(yes.approved, true);
  assert.deepEqual(calls.map((call) => call.name), ["request_approval", "run_approvals", "wait_for_approval", "run_approvals", "wait_for_approval"]);
  assert.ok(calls.filter((call) => call.name === "wait_for_approval").every((call) => call.args.requestId === "apr_board"));

  const next = await askInRun(async () => session, store, request);
  assert.equal(next.pending, true);
  assert.equal(calls.at(-1)!.name, "request_approval");
});

test("a remembered request is used only if the panel shows it for the same run, step and summary", async () => {
  const home = mkdtempSync(join(tmpdir(), "understudy-asks-"));
  const store = openAskStore(askStoreFile(home));
  const request = { runId: "run_board", stepId: "s2", summary: "Send the board update", fields: [] };
  store.remember(request, "apr_other");
  const { session, calls } = fakeGatekeeper({
    run_approvals: () => JSON.stringify({ runId: "run_board", pending: [], answered: [{ requestId: "apr_other", stepId: "s2", summary: "Delete every card", status: "approved" }] }),
    request_approval: () => JSON.stringify({ status: "pending", requestId: "apr_new" }),
  });
  const answer = await askInRun(async () => session, store, request);
  assert.deepEqual(calls.map((call) => call.name), ["run_approvals", "request_approval"]);
  assert.equal(answer.requestId, "apr_new");
  assert.equal(store.asked(request), "apr_new");
});

test("a panel that cannot be reached while waiting is a pending answer, not a no", async () => {
  const home = mkdtempSync(join(tmpdir(), "understudy-asks-"));
  const store = openAskStore(askStoreFile(home));
  const request = { runId: "run_board", stepId: "s2", summary: "Send the board update", fields: [] };
  store.remember(request, "apr_board");
  const answer = await askInRun(async () => {
    throw new Error("fetch failed");
  }, store, request);
  assert.deepEqual({ approved: answer.approved, pending: answer.pending, requestId: answer.requestId }, { approved: false, pending: true, requestId: "apr_board" });
  assert.match(pendingText(request.summary, "do the same action again", answer), /yet \(the panel could not be reached \(fetch failed\)/);
  assert.equal(store.asked(request), "apr_board");
});

test("outside a run, one ask waits once and a pending answer does nothing and says so", async () => {
  const home = mkdtempSync(join(tmpdir(), "understudy-asks-"));
  const { session, calls } = fakeGatekeeper({ request_approval: () => pendingReply, wait_for_approval: () => assert.fail("no second wait") });
  const answer = await askOwnerFor(async () => session, openAskStore(askStoreFile(home)), { summary: "Click Send on mail.example.com", fields: [] });
  assert.deepEqual({ approved: answer.approved, pending: answer.pending }, { approved: false, pending: true });
  assert.deepEqual(calls.map((call) => call.name), ["request_approval"]);
  assert.match(pendingText("Click Send on mail.example.com", null, answer), /^pending: [\s\S]*nothing was done\. Tell your owner it waits for their answer/);
});

test("a no that arrives while the run waits is not handed to the main model to ask again", async () => {
  const before = process.env.UNDERSTUDY_RUN_MODEL;
  process.env.UNDERSTUDY_RUN_MODEL = "haiku";
  try {
    const desk = ownerDesk();
    desk.ask("apr_board", "Send the board update", "s2");
    const { agent, requests, sent } = harness((_request, index) =>
      index === 0 ? gaveUp : { events: [], result: { ok: true, text: 'RESULT {"ok": false, "summary": "Skipped the board update: the owner said no"}', sessionId: "session-1" } },
    desk.lookup);
    agent.setModel("opus");
    agent.enqueue({ kind: "run", runId: "run_board", recipe, approvalsRequired: true });
    await until(() => desk.calls.some((call) => call.wait), "the wait");
    desk.answer("apr_board", "denied", "not this week");
    await until(() => sent.some((message) => message.type === "run_finished"), "the run to finish");
    assert.deepEqual(requests.map((request) => request.model ?? null), ["haiku", "haiku"]);
    assert.match(requests[1].prompt, /: denied, with the note "not this week"/);
  } finally {
    if (before === undefined) delete process.env.UNDERSTUDY_RUN_MODEL;
    else process.env.UNDERSTUDY_RUN_MODEL = before;
  }
});

test("an owner who answers while the computer is down has that answer used once the computer is back", async () => {
  let status = "pending";
  let answeredAt: string | null = null;
  const lookup: RunApprovalsLookup = async () => ({
    pending: status === "pending" ? [{ requestId: "apr_board", summary: "Send the board update", stepId: "s2" }] : [],
    answered: status === "pending" ? [] : [{ requestId: "apr_board", summary: "Send the board update", stepId: "s2", status, answeredAt, used: false }],
    open: true,
  });
  const before = harness((request) => {
    request.onEvent({ kind: "session", sessionId: "session-before" });
    return new Promise<Planned>(() => {});
  }, lookup);
  before.agent.enqueue({ kind: "run", runId: "run_board", recipe, approvalsRequired: true });
  await until(() => before.requests.length === 1, "the first turn");
  await new Promise((resolve) => setTimeout(resolve, 20));
  status = "approved";
  answeredAt = new Date().toISOString();
  const after = harness(() => ({ events: [], result: { ok: true, text: 'RESULT {"ok": true, "summary": "Sent the board update"}', sessionId: "session-before" } }), lookup, before.home);
  after.agent.resumeOpenRuns();
  await until(() => after.sent.some((message) => message.type === "run_finished"), "the run to finish");
  assert.equal(after.requests.length, 1);
  assert.equal(after.requests[0].resume, "session-before");
  assert.match(after.requests[0].prompt, /"Send the board update" \(step s2\) \[requestId: apr_board\]: approved/);
  assert.deepEqual(after.sent.find((message) => message.type === "run_finished"), { type: "run_finished", runId: "run_board", ok: true, summary: "Sent the board update" });
  assert.deepEqual(after.sent.filter((message) => message.type === "turn"), [{ type: "turn", runId: "run_board" }, { type: "turn", runId: "run_board" }]);
});

test("after a restart, answers the run already saw or already used are not handed back", async () => {
  const lookup: RunApprovalsLookup = async () => ({
    pending: [],
    answered: [
      { requestId: "apr_seen", summary: "Remove the book", stepId: "s2", status: "approved", answeredAt: new Date().toISOString(), used: false },
      { requestId: "apr_used", summary: "Send the email", stepId: "s3", status: "approved", answeredAt: new Date().toISOString(), used: true },
    ],
    open: true,
  });
  const before = harness((request) => {
    request.onEvent({ kind: "session", sessionId: "session-before" });
    request.onEvent({ kind: "tool_result", name: "mcp__browser__browser_ask_first", isError: false, text: 'approved: do exactly this now: "Remove the book". [requestId: apr_seen]' });
    return new Promise<Planned>(() => {});
  }, lookup);
  before.agent.enqueue({ kind: "run", runId: "run_books", recipe, approvalsRequired: true });
  await until(() => before.requests.length === 1, "the first turn");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const after = harness(() => assert.fail("no turn"), lookup, before.home);
  after.agent.resumeOpenRuns();
  await until(() => after.sent.some((message) => message.type === "run_finished"), "the run to close");
  assert.deepEqual(after.sent.find((message) => message.type === "run_finished"), { type: "run_finished", runId: "run_books", ok: false, summary: RESTARTED_SUMMARY });
});

test("a run still queued when the computer stops starts fresh when it comes back, unless the panel closed it", async () => {
  const lookup: RunApprovalsLookup = async (runId, wait, signal) => {
    if (runId === "run_first" && wait) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    if (runId === "run_closed") return { pending: [], answered: [], open: false };
    return runId === "run_first" ? { pending: [{ requestId: "apr_first", summary: "Send A", stepId: "s2" }], answered: [], open: true } : { pending: [], answered: [], open: true };
  };
  const before = harness((request) => {
    request.onEvent({ kind: "session", sessionId: "session-first" });
    return { events: [], result: { ok: true, text: 'RESULT {"ok": false, "summary": "waiting"}', sessionId: "session-first" } };
  }, lookup);
  before.agent.enqueue({ kind: "run", runId: "run_first", recipe, approvalsRequired: true });
  before.agent.enqueue({ kind: "run", runId: "run_queued", recipe, approvalsRequired: true });
  before.agent.enqueue({ kind: "run", runId: "run_closed", recipe, approvalsRequired: true });
  await until(() => before.agent.state() === "waiting_you", "the first run to wait");
  const stored = JSON.parse(readFileSync(join(before.home, ".understudy", "open-runs.json"), "utf8"));
  assert.deepEqual(Object.keys(stored).sort(), ["run_closed", "run_first", "run_queued"]);
  assert.equal(stored.run_queued.started, false);

  const after = harness(() => ({ events: [], result: { ok: true, text: 'RESULT {"ok": true, "summary": "Done"}', sessionId: "session-new" } }), async (runId, wait, signal) => (runId === "run_first" ? lookup(runId, wait, signal) : runId === "run_closed" ? { pending: [], answered: [], open: false } : { pending: [], answered: [], open: true }), before.home);
  after.agent.resumeOpenRuns();
  await until(() => after.agent.state() === "waiting_you", "the first run to wait again");
  after.agent.stopRun("run_first", "test over");
  await until(() => after.sent.filter((message) => message.type === "run_finished").length === 3, "all three runs to end");
  const finished = Object.fromEntries(after.sent.filter((message) => message.type === "run_finished").map((message) => [(message as { runId: string }).runId, message]));
  assert.deepEqual(finished.run_queued, { type: "run_finished", runId: "run_queued", ok: true, summary: "Done" });
  assert.equal(after.requests.filter((request) => request.resume === null).length, 1);
  assert.deepEqual(finished.run_closed, { type: "run_finished", runId: "run_closed", ok: false, summary: PANEL_CLOSED_SUMMARY, outcome: "stopped" });
  before.agent.stop();
});
