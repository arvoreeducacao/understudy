import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ComputerToServer } from "@understudy/protocol";
import { createAgent } from "./agent.ts";
import { clearStaleRefreshLock, createBrainLock, isRefreshRace, isSignedOut, REFRESH_LOCK_NAME } from "./brain-lock.ts";
import { startTurn, type BrainEvent, type Turn, type TurnRequest, type TurnResult } from "./brain.ts";
import { readClaudeStatus } from "./login.ts";
import { createMemory } from "./memory.ts";

const RACE = "Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. This is usually transient; retry in a minute";

const config = { home: "/nowhere", workDir: "/nowhere/work", serverUrl: "http://x", token: "t" };

function request(events: BrainEvent[] = []): TurnRequest {
  return { brain: "claude", prompt: "go", system: "s", onEvent: (event) => events.push(event) };
}

function scripted(plan: Array<{ result: Partial<TurnResult>; events?: BrainEvent[] }>) {
  const spawned: TurnRequest[] = [];
  const spawnTurn = (_config: unknown, turnRequest: TurnRequest): Turn => {
    spawned.push(turnRequest);
    const step = plan[Math.min(spawned.length - 1, plan.length - 1)];
    for (const event of step.events ?? []) turnRequest.onEvent(event);
    return { done: Promise.resolve({ ok: false, sessionId: null, text: "", ...step.result }), cancel: () => {} };
  };
  return { spawned, spawnTurn };
}

async function settle() {
  for (let index = 0; index < 20; index++) await new Promise((resolve) => setImmediate(resolve));
}

test("the brain lock runs one task at a time in order", async () => {
  const lock = createBrainLock();
  const order: string[] = [];
  let release!: () => void;
  const first = lock.run(async () => {
    order.push("first starts");
    await new Promise<void>((resolve) => (release = resolve));
    order.push("first ends");
    return 1;
  });
  const second = lock.run(async () => {
    order.push("second starts");
    return 2;
  });
  await settle();
  assert.equal(lock.busy(), true);
  assert.deepEqual(order, ["first starts"]);
  release();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(order, ["first starts", "first ends", "second starts"]);
  assert.equal(lock.busy(), false);
});

test("a failing task does not jam the brain lock", async () => {
  const lock = createBrainLock();
  await assert.rejects(lock.run(async () => Promise.reject(new Error("boom"))));
  assert.equal(await lock.run(async () => "next"), "next");
});

test("only a refresh lock older than the stale window is removed", () => {
  const dir = mkdtempSync(join(tmpdir(), "understudy-lock-"));
  const lockPath = join(dir, REFRESH_LOCK_NAME);
  assert.equal(clearStaleRefreshLock(dir), false);
  mkdirSync(lockPath);
  assert.equal(clearStaleRefreshLock(dir, Date.now(), 30000), false);
  assert.equal(existsSync(lockPath), true);
  const old = new Date(Date.now() - 5 * 60 * 1000);
  utimesSync(lockPath, old, old);
  assert.equal(clearStaleRefreshLock(dir, Date.now(), 30000), true);
  assert.equal(existsSync(lockPath), false);
});

test("refresh races and signed-out errors are told apart", () => {
  assert.equal(isRefreshRace(RACE), true);
  assert.equal(isSignedOut(RACE), false);
  assert.equal(isSignedOut("Not logged in · Please run /login"), true);
  assert.equal(isSignedOut("OAuth token revoked · Please run /login"), true);
  assert.equal(isSignedOut("Login expired · Please run /login"), true);
  assert.equal(isRefreshRace("the page timed out"), false);
  assert.equal(isSignedOut("the page timed out"), false);
});

test("a turn that hits a refresh race is retried and then succeeds", async () => {
  const events: BrainEvent[] = [];
  const { spawned, spawnTurn } = scripted([
    { result: { error: RACE, usage: { inputTokens: 1, outputTokens: 0 } } },
    { result: { error: RACE } },
    { result: { ok: true, text: "done", sessionId: "s1", usage: { inputTokens: 5, outputTokens: 2 } }, events: [{ kind: "text", text: "done" }] },
  ]);
  const result = await startTurn(config, request(events), { spawnTurn, lock: createBrainLock(), retryDelaysMs: [1, 1, 1], clearStaleLock: () => false }).done;
  assert.equal(spawned.length, 3);
  assert.equal(result.ok, true);
  assert.equal(result.needsLogin, undefined);
  assert.deepEqual(result.usage, { inputTokens: 6, outputTokens: 2 });
  assert.deepEqual(events, [{ kind: "text", text: "done" }]);
});

test("a refresh race that never clears asks the owner to sign in again", async () => {
  const { spawned, spawnTurn } = scripted([{ result: { error: RACE } }]);
  const result = await startTurn(config, request(), { spawnTurn, lock: createBrainLock(), retryDelaysMs: [1, 1], clearStaleLock: () => false }).done;
  assert.equal(spawned.length, 3);
  assert.equal(result.ok, false);
  assert.equal(result.needsLogin, true);
  assert.match(result.error ?? "", /signed out on this computer.*connect Claude again/);
});

test("a signed-out brain is not retried", async () => {
  const { spawned, spawnTurn } = scripted([{ result: { error: "Not logged in · Please run /login" } }]);
  const result = await startTurn(config, request(), { spawnTurn, lock: createBrainLock(), retryDelaysMs: [1, 1], clearStaleLock: () => false }).done;
  assert.equal(spawned.length, 1);
  assert.equal(result.needsLogin, true);
});

test("a turn that already did work is never replayed", async () => {
  const { spawned, spawnTurn } = scripted([{ result: { error: RACE }, events: [{ kind: "tool", name: "mcp__browser__browser_navigate", input: {} }] }]);
  const result = await startTurn(config, request(), { spawnTurn, lock: createBrainLock(), retryDelaysMs: [1, 1], clearStaleLock: () => false }).done;
  assert.equal(spawned.length, 1);
  assert.equal(result.ok, false);
  assert.equal(result.error, RACE);
  assert.equal(result.needsLogin, undefined);
});

test("stopping a turn while it waits to retry ends it without another attempt", async () => {
  const { spawned, spawnTurn } = scripted([{ result: { error: RACE } }]);
  const turn = startTurn(config, request(), { spawnTurn, lock: createBrainLock(), retryDelaysMs: [60000], clearStaleLock: () => false });
  await settle();
  turn.cancel();
  const result = await turn.done;
  assert.equal(spawned.length, 1);
  assert.equal(result.ok, false);
  assert.equal(result.needsLogin, undefined);
});

test("two turns on the same credentials never run their brains at the same time", async () => {
  const lock = createBrainLock();
  let running = 0;
  let peak = 0;
  const spawnTurn = (): Turn => {
    running++;
    peak = Math.max(peak, running);
    const done = new Promise<TurnResult>((resolve) =>
      setTimeout(() => {
        running--;
        resolve({ ok: true, sessionId: "s", text: "ok" });
      }, 5),
    );
    return { done, cancel: () => {} };
  };
  const options = { spawnTurn, lock, retryDelaysMs: [], clearStaleLock: () => false };
  const results = await Promise.all([startTurn(config, request(), options).done, startTurn(config, request(), options).done]);
  assert.deepEqual(results.map((result) => result.ok), [true, true]);
  assert.equal(peak, 1);
});

test("the status check clears a leftover refresh lock and waits long enough for a refresh", async () => {
  const home = mkdtempSync(join(tmpdir(), "understudy-home-"));
  const lockPath = join(home, ".claude", REFRESH_LOCK_NAME);
  mkdirSync(lockPath, { recursive: true });
  const old = new Date(Date.now() - 5 * 60 * 1000);
  utimesSync(lockPath, old, old);
  let timeout = 0;
  const status = await readClaudeStatus({ HOME: home }, home, async (_command, _args, _env, ms) => {
    timeout = ms ?? 0;
    return { code: 0, out: '{"loggedIn": true, "email": "owner@example.com"}' };
  });
  assert.deepEqual(status, { brain: "claude", loggedIn: true, account: "owner@example.com" });
  assert.equal(existsSync(lockPath), false);
  assert.ok(timeout >= 60000);
});

test("a run that needs a new sign-in tells the owner instead of showing the raw error", async () => {
  const home = mkdtempSync(join(tmpdir(), "understudy-"));
  const sent: ComputerToServer[] = [];
  const message = "Claude is signed out on this computer. Open the agent's settings and connect Claude again, then run it again.";
  const agent = createAgent({
    config: { home, workDir: join(home, "work"), serverUrl: "http://x", token: "t" },
    memory: createMemory(home),
    settingsFile: join(home, ".understudy", "settings.json"),
    send: (sentMessage) => (sent.push(sentMessage), true),
    runTurn: (() => ({ done: Promise.resolve({ ok: false, sessionId: null, text: "", error: message, needsLogin: true }), cancel: () => {} })) as never,
  });
  agent.enqueue({ kind: "run", runId: "r1", recipe: { title: "Weekly check", trigger: "x", steps: [{ id: "s1", text: "Check", mode: "auto" }], questions: [], askFirstRuns: 0 }, approvalsRequired: false });
  await settle();
  assert.deepEqual(sent.find((sentMessage) => sentMessage.type === "login_done"), { type: "login_done", brain: "claude", ok: false, message });
  assert.deepEqual(sent.find((sentMessage) => sentMessage.type === "run_finished"), { type: "run_finished", runId: "r1", ok: false, summary: message });
  assert.deepEqual(sent.filter((sentMessage) => sentMessage.type === "state").at(-1), { type: "state", state: "stuck", note: message });
});
