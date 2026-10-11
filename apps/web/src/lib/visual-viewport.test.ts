import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { viewportBox } from "./visual-viewport";

describe("visual viewport box", () => {
  it("matches the screen when no keyboard is open", () => {
    assert.deepEqual(viewportBox(844, { height: 844, offsetTop: 0 }), { height: 844, top: 0, keyboard: false });
  });

  it("shrinks to the space above the keyboard and follows the scroll offset", () => {
    assert.deepEqual(viewportBox(844, { height: 508.4, offsetTop: 290.6 }), { height: 508, top: 291, keyboard: true });
  });

  it("ignores small changes like a collapsing toolbar", () => {
    assert.equal(viewportBox(844, { height: 790, offsetTop: 0 }).keyboard, false);
  });
});
