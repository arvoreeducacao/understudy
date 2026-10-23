import assert from "node:assert/strict";
import { test } from "node:test";
import { TurnLedger } from "./turn-ledger";

test("a turn is private only to someone the panel delivered a message for", () => {
  const ledger = new TurnLedger();
  ledger.delivered("agt_1", { type: "chat", text: "north list", from: "Rafael", askedBy: "usr_rafael" });
  assert.deepEqual(ledger.started("agt_1", { askedBy: "usr_tiago" }), { audience: null, roomId: null, matched: false });
  assert.deepEqual(ledger.started("agt_1", { askedBy: "usr_rafael" }), { audience: "usr_rafael", roomId: null, matched: true });
  assert.equal(ledger.audience("agt_1"), "usr_rafael");
  assert.deepEqual(ledger.started("agt_1", { askedBy: "usr_rafael" }), { audience: null, roomId: null, matched: false });
  assert.equal(ledger.audience("agt_1"), null);
});

test("a group turn carries its room, and a private turn never takes a group's place", () => {
  const ledger = new TurnLedger();
  ledger.delivered("agt_1", { type: "room_turn", roomId: "room_1", prompt: "TEAM GROUP CHAT", askedBy: "usr_rafael" });
  ledger.delivered("agt_1", { type: "chat", text: "refund?", from: "Rafael", askedBy: "usr_rafael" });
  assert.deepEqual(ledger.started("agt_1", { askedBy: "usr_rafael" }), { audience: "usr_rafael", roomId: null, matched: true });
  assert.equal(ledger.room("agt_1"), null);
  assert.deepEqual(ledger.started("agt_1", { askedBy: "usr_rafael", roomId: "room_1" }), { audience: "usr_rafael", roomId: "room_1", matched: true });
  assert.equal(ledger.room("agt_1"), "room_1");
  ledger.started("agt_1", { runId: "run_1" });
  assert.equal(ledger.room("agt_1"), null);
  assert.equal(ledger.audience("agt_1"), null);
});
