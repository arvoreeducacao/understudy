export type ViewportBox = { height: number; top: number; keyboard: boolean };

export const KEYBOARD_MIN_PX = 120;

export function viewportBox(layoutHeight: number, visual: { height: number; offsetTop: number }): ViewportBox {
  const height = Math.max(0, Math.min(layoutHeight, Math.round(visual.height)));
  const top = Math.max(0, Math.round(visual.offsetTop));
  return { height, top, keyboard: layoutHeight - height >= KEYBOARD_MIN_PX };
}
