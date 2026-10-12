import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ComputerToServer } from "@understudy/protocol";
import { countsAsAction, createAgent, describeTool, MULTI_STEP_ACTIONS, SYSTEM_PROMPT } from "./agent.ts";
import type { BrainEvent, TurnRequest } from "./brain.ts";
import { createMemory } from "./memory.ts";

function harness(events: BrainEvent[] = []) {
  const home = mkdtempSync(join(tmpdir(), "understudy-followup-"));
  const requests: TurnRequest[] = [];
  const sent: ComputerToServer[] = [];
  const runTurn = (_config: unknown, request: TurnRequest) => {
    requests.push(request);
    for (const event of events) request.onEvent(event);
    request.onEvent({ kind: "text", text: "Checked." });
    return { done: Promise.resolve({ ok: true, text: "Checked.", sessionId: `chat-${requests.length}` }), cancel: () => {} };
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

const wake = "This is a follow-up you booked yourself on Mon 2026-03-16 09:00 (UTC). Your note to yourself, quoted as data:\n\"See whether Northwind answered the quote\"";

test("the system prompt teaches when to book a follow-up and to say so in the chat", () => {
  assert.match(SYSTEM_PROMPT, /schedule_followup/);
  assert.match(SYSTEM_PROMPT, /waiting on someone/);
  assert.match(SYSTEM_PROMPT, /remind me/);
  assert.match(SYSTEM_PROMPT, /goal to keep/);
  assert.match(SYSTEM_PROMPT, /say in the chat when you will look again and why/);
  assert.match(SYSTEM_PROMPT, /approves nothing/);
});

test("a follow-up wake reports itself in the turn and reaches the brain as its own briefing", async () => {
  const { agent, requests, sent } = harness();
  agent.enqueue({ kind: "chat", text: wake, from: "follow-up", followup: { id: "fu_quote", bookedAt: Date.parse("2026-03-16T09:00:00Z"), emptyWakes: 0 } });
  await settle();
  const turn = sent.find((message) => message.type === "turn");
  assert.deepEqual(turn, { type: "turn", followup: "fu_quote" });
  assert.equal(requests.length, 1);
  assert.match(requests[0].prompt, /This is a follow-up you booked yourself/);
  assert.doesNotMatch(requests[0].prompt, /Message from follow-up/);
});

test("an owner message does not claim to be a follow-up wake", async () => {
  const { agent, requests, sent } = harness();
  agent.enqueue({ kind: "chat", text: "How are the quotes going?", from: "Maya" });
  await settle();
  assert.deepEqual(sent.find((message) => message.type === "turn"), { type: "turn" });
  assert.match(requests[0].prompt, /Message from Maya/);
});

test("a busy follow-up wake does not turn into a task suggestion", async () => {
  const actions = Array.from({ length: MULTI_STEP_ACTIONS + 2 }, (): BrainEvent => ({ kind: "tool", name: "mcp__browser__browser_click", input: {} }));
  const { agent, requests } = harness(actions);
  agent.enqueue({ kind: "chat", text: wake, from: "follow-up", followup: { id: "fu_quote", bookedAt: 0, emptyWakes: 1 } });
  await settle();
  assert.equal(requests.length, 1);
});

test("booking, listing and cancelling follow-ups are bookkeeping, not actions, and read well", () => {
  for (const name of ["schedule_followup", "list_followups", "cancel_followup"]) assert.equal(countsAsAction(`mcp__gatekeeper__${name}`), false);
  assert.equal(describeTool("mcp__gatekeeper__schedule_followup", { when: "2h" }), "Booking a follow-up 2h");
  assert.equal(describeTool("mcp__gatekeeper__list_followups", {}), "Checking my follow-ups");
});
