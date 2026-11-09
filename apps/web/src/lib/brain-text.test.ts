import assert from "node:assert/strict";
import { test } from "node:test";
import { brainText } from "./brain-text";

test("a pending answer tells the brain to keep waiting and never offers ending the run", () => {
  assert.doesNotMatch(brainText.pendingNote, /end the run saying/);
  assert.match(brainText.pendingNote, /call wait_for_approval with this requestId and keep waiting/);
  assert.match(brainText.pendingNote, /never end it, fail it or skip the step because the answer is pending/);
  assert.match(brainText.pendingNote, /Never do the step meanwhile/);
});
