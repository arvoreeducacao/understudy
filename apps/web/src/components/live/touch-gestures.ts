export const LONG_PRESS_MS = 500;
export const DRAG_SLOP_PX = 8;
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

export type GestureAction =
  | { type: "click"; x: number; y: number }
  | { type: "contextClick"; x: number; y: number }
  | { type: "drag"; x: number; y: number; dx: number; dy: number }
  | { type: "pinch"; factor: number; centerX: number; centerY: number; panX: number; panY: number };

type Point = { x: number; y: number };
type Mode = "idle" | "press" | "drag" | "pinch" | "spent";

function distance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function createGestures(emit: (action: GestureAction) => void) {
  const points = new Map<number, Point>();
  let mode: Mode = "idle";
  let start: (Point & { at: number }) | null = null;
  let last: Point | null = null;
  let pinch: { distance: number; center: Point } | null = null;

  function pair(): [Point, Point] | null {
    const [a, b] = [...points.values()];
    return a && b ? [a, b] : null;
  }

  function beginPinch() {
    const both = pair();
    if (!both) return;
    mode = "pinch";
    pinch = { distance: Math.max(1, distance(both[0], both[1])), center: midpoint(both[0], both[1]) };
  }

  return {
    down(id: number, x: number, y: number, at: number) {
      points.set(id, { x, y });
      if (points.size === 1 && (mode === "idle" || mode === "spent")) {
        mode = "press";
        start = { x, y, at };
        last = { x, y };
        return;
      }
      if (points.size === 2) beginPinch();
    },
    move(id: number, x: number, y: number) {
      if (!points.has(id)) return;
      points.set(id, { x, y });
      if (mode === "pinch") {
        const both = pair();
        if (!both || !pinch) return;
        const nextDistance = Math.max(1, distance(both[0], both[1]));
        const center = midpoint(both[0], both[1]);
        emit({ type: "pinch", factor: nextDistance / pinch.distance, centerX: center.x, centerY: center.y, panX: center.x - pinch.center.x, panY: center.y - pinch.center.y });
        pinch = { distance: nextDistance, center };
        return;
      }
      if (!start || !last) return;
      if (mode === "press" && distance(start, { x, y }) > DRAG_SLOP_PX) mode = "drag";
      if (mode === "drag") {
        emit({ type: "drag", x, y, dx: x - last.x, dy: y - last.y });
        last = { x, y };
      }
    },
    up(id: number) {
      if (!points.delete(id)) return;
      if (mode === "press" && points.size === 0 && start) emit({ type: "click", x: start.x, y: start.y });
      if (mode === "pinch" && points.size < 2) pinch = null;
      if (points.size === 0) {
        mode = "idle";
        start = null;
        last = null;
      } else if (mode === "pinch" || mode === "press") {
        mode = "spent";
      }
    },
    cancel() {
      points.clear();
      mode = "idle";
      start = null;
      last = null;
      pinch = null;
    },
    tick(at: number) {
      if (mode !== "press" || !start || points.size !== 1) return;
      if (at - start.at < LONG_PRESS_MS) return;
      mode = "spent";
      emit({ type: "contextClick", x: start.x, y: start.y });
    },
    get active() {
      return points.size;
    },
  };
}

export type ZoomView = { scale: number; x: number; y: number };

export const IDENTITY_VIEW: ZoomView = { scale: 1, x: 0, y: 0 };

export function clampView(view: ZoomView, box: { width: number; height: number }): ZoomView {
  const scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.scale));
  const limitX = ((scale - 1) * box.width) / 2;
  const limitY = ((scale - 1) * box.height) / 2;
  return {
    scale,
    x: Math.min(limitX, Math.max(-limitX, view.x)),
    y: Math.min(limitY, Math.max(-limitY, view.y)),
  };
}

export function zoomAt(view: ZoomView, factor: number, focus: { x: number; y: number }, box: { width: number; height: number }): ZoomView {
  const scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.scale * factor));
  const contentX = (focus.x - view.x) / view.scale;
  const contentY = (focus.y - view.y) / view.scale;
  return clampView({ scale, x: focus.x - contentX * scale, y: focus.y - contentY * scale }, box);
}

export function panBy(view: ZoomView, dx: number, dy: number, box: { width: number; height: number }): ZoomView {
  return clampView({ ...view, x: view.x + dx, y: view.y + dy }, box);
}
