import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DRAG_SLOP_PX, IDENTITY_VIEW, LONG_PRESS_MS, MAX_ZOOM, clampView, createGestures, panBy, zoomAt, type GestureAction } from "./touch-gestures";

function tracker() {
  const actions: GestureAction[] = [];
  const gestures = createGestures((action) => actions.push(action));
  return { actions, gestures };
}

describe("touch gestures", () => {
  it("turns a quick tap into a click where the finger landed", () => {
    const { actions, gestures } = tracker();
    gestures.down(1, 100, 200, 0);
    gestures.move(1, 103, 202);
    gestures.up(1);
    assert.deepEqual(actions, [{ type: "click", x: 100, y: 200 }]);
  });

  it("turns a held finger into a context click and no click on release", () => {
    const { actions, gestures } = tracker();
    gestures.down(1, 50, 60, 1000);
    gestures.tick(1000 + LONG_PRESS_MS - 1);
    assert.equal(actions.length, 0);
    gestures.tick(1000 + LONG_PRESS_MS);
    gestures.up(1);
    assert.deepEqual(actions, [{ type: "contextClick", x: 50, y: 60 }]);
  });

  it("turns a moving finger into drags with deltas and never clicks", () => {
    const { actions, gestures } = tracker();
    gestures.down(1, 100, 300, 0);
    gestures.move(1, 100, 300 - DRAG_SLOP_PX - 2);
    gestures.move(1, 100, 260);
    gestures.tick(LONG_PRESS_MS * 2);
    gestures.up(1);
    assert.deepEqual(actions, [
      { type: "drag", x: 100, y: 290, dx: 0, dy: -10 },
      { type: "drag", x: 100, y: 260, dx: 0, dy: -30 },
    ]);
  });

  it("turns two fingers into a pinch and swallows the click", () => {
    const { actions, gestures } = tracker();
    gestures.down(1, 100, 100, 0);
    gestures.down(2, 200, 100, 10);
    gestures.move(2, 300, 100);
    gestures.up(2);
    gestures.up(1);
    assert.equal(actions.length, 1);
    const [pinch] = actions;
    assert.equal(pinch.type, "pinch");
    if (pinch.type !== "pinch") return;
    assert.equal(pinch.factor, 2);
    assert.equal(pinch.centerX, 200);
    assert.equal(pinch.panX, 50);
  });

  it("starts fresh after a cancel", () => {
    const { actions, gestures } = tracker();
    gestures.down(1, 10, 10, 0);
    gestures.cancel();
    gestures.up(1);
    gestures.down(2, 20, 20, 5);
    gestures.up(2);
    assert.deepEqual(actions, [{ type: "click", x: 20, y: 20 }]);
  });
});

describe("zoom view", () => {
  const box = { width: 400, height: 250 };

  it("keeps the point under the fingers still while zooming", () => {
    const view = zoomAt(IDENTITY_VIEW, 2, { x: 100, y: 50 }, box);
    assert.equal(view.scale, 2);
    assert.equal(view.x, -100);
    assert.equal(view.y, -50);
  });

  it("never zooms out past the fitted size or in past the maximum", () => {
    assert.deepEqual(zoomAt(IDENTITY_VIEW, 0.5, { x: 0, y: 0 }, box), IDENTITY_VIEW);
    assert.equal(zoomAt(IDENTITY_VIEW, 100, { x: 0, y: 0 }, box).scale, MAX_ZOOM);
  });

  it("keeps the screen covering the stage when panning", () => {
    const zoomed = { scale: 2, x: 0, y: 0 };
    assert.deepEqual(panBy(zoomed, 1000, -1000, box), { scale: 2, x: 200, y: -125 });
    assert.deepEqual(clampView({ scale: 1, x: 30, y: 30 }, box), IDENTITY_VIEW);
  });
});
