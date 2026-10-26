import assert from "node:assert/strict";
import { test } from "node:test";
import { FRAME_BACKLOG_BYTES, FRAMES_IN_FLIGHT, frameAcked, frameCredit, takeFrameSlot } from "./frame-credit";

test("a viewer that confirms frames gets a few ahead and one more per confirmation", () => {
  const credit = frameCredit(true);
  const sent = Array.from({ length: 5 }, () => takeFrameSlot(credit, 0)).filter(Boolean).length;
  assert.equal(sent, FRAMES_IN_FLIGHT);
  assert.equal(frameAcked(credit), true);
  assert.equal(takeFrameSlot(credit, 0), true);
  assert.equal(takeFrameSlot(credit, 0), false);
});

test("a confirmation with nothing skipped asks for no catch-up frame", () => {
  const credit = frameCredit(true);
  takeFrameSlot(credit, 0);
  assert.equal(frameAcked(credit), false);
  assert.equal(frameAcked(credit), false);
  assert.equal(credit.inFlight, 0);
});

test("frames stop while the socket still holds a backlog, for any viewer", () => {
  assert.equal(takeFrameSlot(frameCredit(false), FRAME_BACKLOG_BYTES), false);
  assert.equal(takeFrameSlot(frameCredit(true), FRAME_BACKLOG_BYTES), false);
  const old = frameCredit(false);
  assert.ok(Array.from({ length: 10 }, () => takeFrameSlot(old, 0)).every(Boolean));
});
