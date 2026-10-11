import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isForwardedHardwareKey, keyPress, readSoftInput, terminalCtrl, terminalSequence, typedText } from "./remote-keys";

describe("remote keys", () => {
  it("presses a named key as a down and an up", () => {
    assert.deepEqual(keyPress("Escape"), [
      { kind: "key", action: "down", key: "Escape", code: "Escape" },
      { kind: "key", action: "up", key: "Escape", code: "Escape" },
    ]);
  });

  it("wraps a key in Control when ctrl is held", () => {
    const events = keyPress("C", true);
    assert.deepEqual(
      events.map((event) => `${event.action}:${event.key}`),
      ["down:Control", "down:c", "up:c", "up:Control"],
    );
    assert.equal(events[1].text, undefined);
    assert.equal(events[1].code, "KeyC");
  });

  it("types text in one go, or as ctrl chords when ctrl is held", () => {
    assert.deepEqual(typedText("héllo"), [{ kind: "key", action: "char", key: "héllo", text: "héllo" }]);
    assert.equal(typedText("a", true).length, 4);
    assert.deepEqual(typedText(""), []);
  });

  it("reads what the on-screen keyboard did", () => {
    assert.deepEqual(readSoftInput("insertText", "a"), { kind: "text", text: "a" });
    assert.deepEqual(readSoftInput("insertReplacementText", "word"), { kind: "text", text: "word" });
    assert.deepEqual(readSoftInput("deleteContentBackward", null), { kind: "key", key: "Backspace" });
    assert.deepEqual(readSoftInput("insertLineBreak", null), { kind: "key", key: "Enter" });
    assert.deepEqual(readSoftInput("insertText", "\n"), { kind: "key", key: "Enter" });
    assert.equal(readSoftInput("historyUndo", null), null);
  });

  it("forwards only keys that do not produce text", () => {
    assert.equal(isForwardedHardwareKey("ArrowUp"), true);
    assert.equal(isForwardedHardwareKey("Delete"), true);
    assert.equal(isForwardedHardwareKey("a"), false);
    assert.equal(isForwardedHardwareKey("Unidentified"), false);
  });

  it("maps bar keys and ctrl chords to terminal bytes", () => {
    assert.equal(terminalSequence("ArrowUp"), "\x1b[A");
    assert.equal(terminalSequence("Enter"), "\r");
    assert.equal(terminalCtrl("c"), "\x03");
    assert.equal(terminalCtrl("D"), "\x04");
    assert.equal(terminalCtrl("1"), "1");
  });
});
