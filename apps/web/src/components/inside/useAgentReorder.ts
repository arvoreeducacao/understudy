"use client";

import { useEffect, useLayoutEffect, useRef, useState, useTransition, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { saveAgentOrder } from "@/app/actions/agents";
import { moveInGroup, sameOrder } from "@/lib/agent-order";

export const HOLD_TO_DRAG_MS = 450;
const TOUCH_SLOP = 8;
const MOUSE_SLOP = 5;
const EDGE = 40;
const EDGE_STEP = 10;
const CLICK_GRACE_MS = 400;

type Reorderable = { id: string; group?: string };

type Drag = {
  id: string;
  pointerId: number;
  touch: boolean;
  startX: number;
  startY: number;
  active: boolean;
  timer: number;
  start: string[];
  list: HTMLElement | null;
};

type Engine = {
  order: { current: string[] };
  groups: { current: Map<string, string | undefined> };
  nodes: Map<string, HTMLElement>;
  swallowClick: { current: boolean };
  keepFocus: { current: string | null };
  isTouchDrag: () => boolean;
  onPointerDown: (event: PointerEvent<HTMLElement>, id: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>, id: string) => void;
  stop: () => void;
};

function createEngine(show: (next: string[]) => void, setDragging: (id: string | null) => void, commit: (next: string[]) => void): Engine {
  const order = { current: [] as string[] };
  const groups = { current: new Map<string, string | undefined>() };
  const nodes = new Map<string, HTMLElement>();
  const swallowClick = { current: false };
  const keepFocus = { current: null as string | null };
  let drag: Drag | null = null;
  let graceTimer = 0;

  const groupOf = (id: string) => groups.current.get(id);

  function place(next: string[]) {
    order.current = next;
    show(next);
  }

  function activate() {
    if (!drag || drag.active) return;
    drag.active = true;
    window.clearTimeout(graceTimer);
    swallowClick.current = true;
    document.documentElement.classList.add("is-reordering");
    if (drag.touch) navigator.vibrate?.(12);
    setDragging(drag.id);
  }

  function follow(clientY: number) {
    if (!drag) return;
    const list = drag.list;
    if (list) {
      const box = list.getBoundingClientRect();
      if (clientY < box.top + EDGE) list.scrollTop -= EDGE_STEP;
      else if (clientY > box.bottom - EDGE) list.scrollTop += EDGE_STEP;
    }
    const id = drag.id;
    const group = groupOf(id);
    const others = order.current.filter((other) => other !== id && groupOf(other) === group);
    let target = others.length;
    for (let index = 0; index < others.length; index++) {
      const node = nodes.get(others[index] as string);
      if (!node) continue;
      const box = node.getBoundingClientRect();
      if (clientY < box.top + box.height / 2) {
        target = index;
        break;
      }
    }
    const next = moveInGroup(order.current, id, target, groupOf);
    if (!sameOrder(next, order.current)) place(next);
  }

  function onMove(event: globalThis.PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.active) {
      if (drag.touch) {
        if (Math.hypot(dx, dy) > TOUCH_SLOP) stop();
        return;
      }
      if (Math.abs(dy) <= MOUSE_SLOP) return;
      activate();
    }
    event.preventDefault();
    follow(event.clientY);
  }

  function onTouchMove(event: TouchEvent) {
    if (drag?.active && event.cancelable) event.preventDefault();
  }

  function onUp(event: globalThis.PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const moved = drag.active && !sameOrder(drag.start, order.current);
    stop();
    if (moved) commit(order.current);
  }

  function onCancel(event: globalThis.PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (drag.active) place(drag.start);
    stop();
  }

  function stop() {
    const wasActive = Boolean(drag?.active);
    if (drag) window.clearTimeout(drag.timer);
    drag = null;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    document.removeEventListener("touchmove", onTouchMove);
    document.documentElement.classList.remove("is-reordering");
    setDragging(null);
    if (wasActive) {
      window.clearTimeout(graceTimer);
      graceTimer = window.setTimeout(() => {
        swallowClick.current = false;
      }, CLICK_GRACE_MS);
    }
  }

  function onPointerDown(event: PointerEvent<HTMLElement>, id: string) {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    stop();
    swallowClick.current = false;
    const touch = event.pointerType !== "mouse";
    drag = {
      id,
      pointerId: event.pointerId,
      touch,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      timer: touch ? window.setTimeout(activate, HOLD_TO_DRAG_MS) : 0,
      start: order.current,
      list: event.currentTarget.closest<HTMLElement>("[data-reorder-list]"),
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    document.addEventListener("touchmove", onTouchMove, { passive: false });
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>, id: string) {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    const members = order.current.filter((other) => groupOf(other) === groupOf(id));
    const at = members.indexOf(id);
    const target = event.key === "ArrowUp" ? at - 1 : at + 1;
    if (at < 0 || target < 0 || target >= members.length) return;
    const next = moveInGroup(order.current, id, target, groupOf);
    keepFocus.current = id;
    place(next);
    commit(next);
  }

  return { order, groups, nodes, swallowClick, keepFocus, isTouchDrag: () => Boolean(drag?.touch), onPointerDown, onKeyDown, stop };
}

export function useAgentReorder<T extends Reorderable>(agents: T[]) {
  const incomingKey = agents.map((agent) => agent.id).join("\n");
  const [order, setOrder] = useState(() => agents.map((agent) => agent.id));
  const [dragging, setDragging] = useState<string | null>(null);
  const [, startSaving] = useTransition();
  const engineRef = useRef<Engine | null>(null);
  if (!engineRef.current) {
    engineRef.current = createEngine(setOrder, setDragging, (next) =>
      startSaving(async () => {
        await saveAgentOrder(next);
      }),
    );
    engineRef.current.order.current = order;
  }
  const engine = engineRef.current;
  engine.groups.current = new Map(agents.map((agent) => [agent.id, agent.group]));

  useEffect(() => {
    if (dragging) return;
    const next = incomingKey ? incomingKey.split("\n") : [];
    engine.order.current = next;
    setOrder(next);
  }, [incomingKey]);

  useLayoutEffect(() => {
    const id = engine.keepFocus.current;
    if (!id) return;
    engine.keepFocus.current = null;
    engine.nodes.get(id)?.focus();
  }, [order]);

  useEffect(() => () => engine.stop(), [engine]);

  function itemProps(id: string) {
    return {
      ref: (node: HTMLElement | null) => {
        if (node) engine.nodes.set(id, node);
        else engine.nodes.delete(id);
      },
      draggable: false,
      "data-dragging": dragging === id ? "" : undefined,
      onPointerDown: (event: PointerEvent<HTMLElement>) => engine.onPointerDown(event, id),
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => engine.onKeyDown(event, id),
      onContextMenu: (event: MouseEvent<HTMLElement>) => {
        if (engine.isTouchDrag()) event.preventDefault();
      },
      onClickCapture: (event: MouseEvent<HTMLElement>) => {
        if (!engine.swallowClick.current) return;
        event.preventDefault();
        event.stopPropagation();
      },
    };
  }

  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const ordered = order.map((id) => byId.get(id)).filter((agent): agent is T => Boolean(agent));
  return { agents: ordered.length === agents.length ? ordered : agents, dragging, itemProps };
}
