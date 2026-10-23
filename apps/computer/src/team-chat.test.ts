import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ComputerToServer } from "@understudy/protocol";
import { createAgent } from "./agent.ts";
import type { TurnRequest } from "./brain.ts";
import { createMemory } from "./memory.ts";

async function settle() {
  for (let index = 0; index < 20; index++) await new Promise((resolve) => setImmediate(resolve));
}

test("each team member chats in a session of their own and the turn says who asked", async () => {
  const home = mkdtempSync(join(tmpdir(), "understudy-team-"));
  const requests: TurnRequest[] = [];
  const sent: ComputerToServer[] = [];
  let session = 0;
  const agent = createAgent({
    config: { home, workDir: join(home, "work"), serverUrl: "http://x", token: "t" },
    memory: createMemory(home),
    settingsFile: join(home, ".understudy", "settings.json"),
    send: (message) => (sent.push(message), true),
    today: () => "2026-10-23",
    runTurn: ((_config: unknown, request: TurnRequest) => {
      requests.push(request);
      session += 1;
      return { done: Promise.resolve({ ok: true, text: "", sessionId: `s${session}` }), cancel: () => {} };
    }) as never,
  });
  agent.enqueue({ kind: "chat", text: "North list please", from: "Rafael", askedBy: "usr_rafael" });
  await settle();
  agent.enqueue({ kind: "chat", text: "Refund for Aurora?", from: "Tiago", askedBy: "usr_tiago" });
  await settle();
  agent.enqueue({ kind: "chat", text: "Sort it by days late", from: "Rafael", askedBy: "usr_rafael" });
  await settle();
  agent.enqueue({ kind: "chat", text: "Anything new?", from: "Marina" });
  await settle();
  assert.deepEqual(requests.map((r) => r.resume ?? null), [null, null, "s1", null]);
  assert.doesNotMatch(requests[1].prompt, /North list/);
  assert.match(requests[1].prompt, /Message from Tiago/);
  assert.deepEqual(
    sent.filter((m) => m.type === "turn"),
    [{ type: "turn", askedBy: "usr_rafael" }, { type: "turn", askedBy: "usr_tiago" }, { type: "turn", askedBy: "usr_rafael" }, { type: "turn" }],
  );
});

test("a team group turn says who it is working for", async () => {
  const home = mkdtempSync(join(tmpdir(), "understudy-team-room-"));
  const sent: ComputerToServer[] = [];
  const agent = createAgent({
    config: { home, workDir: join(home, "work"), serverUrl: "http://x", token: "t" },
    memory: createMemory(home),
    settingsFile: join(home, ".understudy", "settings.json"),
    send: (message) => (sent.push(message), true),
    today: () => "2026-10-23",
    runTurn: (() => ({ done: Promise.resolve({ ok: true, text: "", sessionId: "s1" }), cancel: () => {} })) as never,
  });
  agent.enqueue({ kind: "room", roomId: "room_1", prompt: "TEAM GROUP CHAT", askedBy: "usr_rafael" });
  await settle();
  assert.deepEqual(sent.find((m) => m.type === "turn"), { type: "turn", untrusted: true, roomId: "room_1", askedBy: "usr_rafael" });
});

test("a follow-up a member booked wakes in that member's own chat, and an outsider's turn says whose channel it is", async () => {
  const home = mkdtempSync(join(tmpdir(), "understudy-team-followup-"));
  const requests: TurnRequest[] = [];
  const sent: ComputerToServer[] = [];
  const agent = createAgent({
    config: { home, workDir: join(home, "work"), serverUrl: "http://x", token: "t" },
    memory: createMemory(home),
    settingsFile: join(home, ".understudy", "settings.json"),
    send: (message) => (sent.push(message), true),
    today: () => "2026-10-23",
    runTurn: ((_config: unknown, request: TurnRequest) => {
      requests.push(request);
      return { done: Promise.resolve({ ok: true, text: "", sessionId: `s${requests.length}` }), cancel: () => {} };
    }) as never,
  });
  agent.enqueue({ kind: "chat", text: "Refund for Aurora?", from: "Tiago", askedBy: "usr_tiago" });
  await settle();
  agent.enqueue({ kind: "chat", text: "check the refund", from: "follow-up", askedBy: "usr_tiago", followup: { id: "fu_1", bookedAt: 1, emptyWakes: 0 } });
  await settle();
  assert.equal(requests[1].resume, "s1");
  assert.deepEqual(sent.filter((m) => m.type === "turn")[1], { type: "turn", askedBy: "usr_tiago", followup: "fu_1" });
  agent.enqueue({ kind: "chat", text: "hi", from: "+55 11 0000", askedBy: "usr_owner", external: { channel: "whatsapp", sender: "+55 11 0000" }, origin: "cth_1" });
  await settle();
  assert.deepEqual(sent.filter((m) => m.type === "turn")[2], { type: "turn", origin: "cth_1", askedBy: "usr_owner", untrusted: true });
});

test("a member's day is not summarized into the journal the whole team shares", async () => {
  const home = mkdtempSync(join(tmpdir(), "understudy-team-journal-"));
  const memory = createMemory(home);
  const requests: TurnRequest[] = [];
  let day = "2026-10-22";
  const agent = createAgent({
    config: { home, workDir: join(home, "work"), serverUrl: "http://x", token: "t" },
    memory,
    settingsFile: join(home, ".understudy", "settings.json"),
    send: () => true,
    today: () => day,
    runTurn: ((_config: unknown, request: TurnRequest) => {
      requests.push(request);
      return { done: Promise.resolve({ ok: true, text: "Talked about the Aurora refund.", sessionId: `s${requests.length}` }), cancel: () => {} };
    }) as never,
  });
  agent.enqueue({ kind: "chat", text: "Refund for Aurora?", from: "Tiago", askedBy: "usr_tiago" });
  await settle();
  day = "2026-10-23";
  agent.enqueue({ kind: "chat", text: "Anything else?", from: "Tiago", askedBy: "usr_tiago" });
  await settle();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].resume ?? null, null);
  assert.deepEqual(memory.lastJournalLines(), []);
});
