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
