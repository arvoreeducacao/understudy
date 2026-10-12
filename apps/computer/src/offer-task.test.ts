import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ComputerToServer } from "@understudy/protocol";
import { countsAsAction, createAgent, MULTI_STEP_ACTIONS, offerTaskPrompt, SYSTEM_PROMPT } from "./agent.ts";
import type { BrainEvent, TurnRequest } from "./brain.ts";
import { createMemory } from "./memory.ts";

type Planned = { events: BrainEvent[]; result: { ok: boolean; text: string; sessionId: string } };

function harness(script: (request: TurnRequest, index: number) => Planned) {
  const home = mkdtempSync(join(tmpdir(), "understudy-offer-"));
  const requests: TurnRequest[] = [];
  const sent: ComputerToServer[] = [];
  const runTurn = (_config: unknown, request: TurnRequest) => {
    requests.push(request);
    const planned = script(request, requests.length - 1);
    for (const event of planned.events) request.onEvent(event);
    return { done: Promise.resolve(planned.result), cancel: () => {} };
  };
  const agent = createAgent({
    config: { home, workDir: join(home, "work"), serverUrl: "http://x", token: "t" },
    memory: createMemory(home),
    settingsFile: join(home, ".understudy", "settings.json"),
    send: (message) => (sent.push(message), true),
    runTurn: runTurn as never,
    today: () => "2026-03-20",
  });
  return { agent, requests, sent };
}

async function settle() {
  for (let index = 0; index < 30; index++) await new Promise((resolve) => setImmediate(resolve));
}

const tool = (name: string): BrainEvent => ({ kind: "tool", name, input: {} });
const done = (events: BrainEvent[], text = "Done.", sessionId = "chat-1"): Planned => ({ events: [...events, { kind: "text", text }], result: { ok: true, text, sessionId } });

test("reading and waiting do not count as actions; doing things does", () => {
  assert.equal(countsAsAction("mcp__browser__browser_snapshot"), false);
  assert.equal(countsAsAction("Read"), false);
  assert.equal(countsAsAction("mcp__gatekeeper__request_approval"), false);
  assert.equal(countsAsAction("mcp__browser__browser_click"), true);
  assert.equal(countsAsAction("mcp__shell__run_command"), true);
});

test("a long ad-hoc job ends with a quiet offer to save it as a task", async () => {
  const actions = Array.from({ length: MULTI_STEP_ACTIONS }, () => tool("mcp__browser__browser_click"));
  const { agent, requests, sent } = harness((_request, index) => (index === 0 ? done(actions) : done([tool("mcp__gatekeeper__propose_task")], "DONE", "chat-2")));
  agent.enqueue({ kind: "chat", text: "Pull the open invoices into a spreadsheet", from: "Maya" });
  await settle();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].resume, "chat-1");
  assert.match(requests[1].prompt, new RegExp(`took ${MULTI_STEP_ACTIONS} actions`));
  assert.match(requests[1].prompt, /propose_task/);
  const chats = sent.filter((message) => message.type === "chat").map((message) => (message as { text: string }).text);
  assert.deepEqual(chats, ["Done."]);
});

test("a short answer gets no offer", async () => {
  const { agent, requests } = harness(() => done([tool("mcp__browser__browser_click")]));
  agent.enqueue({ kind: "chat", text: "What is on the dashboard?", from: "Maya" });
  await settle();
  assert.equal(requests.length, 1);
});

test("a repeated ask gets an offer even when it was quick", async () => {
  const { agent, requests } = harness((_request, index) => (index === 0 ? done([]) : done([], "DONE")));
  agent.enqueue({ kind: "chat", text: "Summarize the support inbox", from: "Maya", repeated: { times: 3, since: Date.parse("2026-03-02T09:00:00Z") } });
  await settle();
  assert.equal(requests.length, 2);
  assert.match(requests[1].prompt, /3 times since 2026-03-02/);
});

test("no second offer when the brain already proposed or saved a task", async () => {
  const actions = Array.from({ length: MULTI_STEP_ACTIONS + 2 }, () => tool("mcp__shell__run_command"));
  const { agent, requests } = harness(() => done([...actions, tool("mcp__gatekeeper__propose_task")]));
  agent.enqueue({ kind: "chat", text: "Build the weekly report", from: "Maya", repeated: { times: 4, since: Date.parse("2026-03-01T09:00:00Z") } });
  await settle();
  assert.equal(requests.length, 1);
});

test("teammates' messages never lead to an offer", async () => {
  const actions = Array.from({ length: MULTI_STEP_ACTIONS + 2 }, () => tool("mcp__shell__run_command"));
  const { agent, requests } = harness(() => done(actions));
  agent.enqueue({ kind: "chat", text: "Can you check the stock?", from: "Ada", fromAgent: { id: "agt_t", name: "Ada" } });
  await settle();
  assert.equal(requests.length, 1);
});

test("the offer prompt keeps the decision with the owner", () => {
  const prompt = offerTaskPrompt({ actions: 9 });
  assert.match(prompt, /not already one of your tasks/);
  assert.match(prompt, /already said not now/);
  assert.match(SYSTEM_PROMPT, /propose_task/);
});
