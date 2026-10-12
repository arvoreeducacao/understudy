"use client";

import { Keyboard, Minus, Plus, Scan } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { InputEvent } from "@understudy/protocol";
import { AgentFigure } from "@/components/AgentFigure";
import { COARSE_POINTER, useMediaQuery } from "@/components/useMediaQuery";
import type { Look } from "@/lib/look";
import { messages } from "@/lib/messages";
import { KeyBar } from "./KeyBar";
import { isForwardedHardwareKey, keyPress, readSoftInput, typedText, type BarKey } from "./remote-keys";
import { IDENTITY_VIEW, LONG_PRESS_MS, createGestures, panBy, zoomAt, type GestureAction, type ZoomView } from "./touch-gestures";
import type { Frame } from "./useAgentSocket";

const t = messages.live;

const MOVE_INTERVAL_MS = 16;
const SCROLL_INTERVAL_MS = 50;
const TOUCH_GRACE_MS = 800;
const ZOOM_STEP = 1.5;
const SENTINEL = "  ";

export function ComputerScreen({
  subscribeFrames,
  sendInput,
  controlling,
  online,
  url,
  label,
  look,
  compact = false,
}: {
  subscribeFrames: (listener: (frame: Frame) => void) => () => void;
  sendInput: (event: InputEvent) => void;
  controlling: boolean;
  online: boolean;
  url: string;
  label?: string;
  look?: Look;
  compact?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const keysRef = useRef<HTMLInputElement | null>(null);
  const sizeRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 });
  const lastMove = useRef(0);
  const lastTouch = useRef(0);
  const [hasFrame, setHasFrame] = useState(false);
  const [desktop, setDesktop] = useState(false);
  const [draftUrl, setDraftUrl] = useState(url);
  const [editingUrl, setEditingUrl] = useState(false);
  const [view, setView] = useState<ZoomView>(IDENTITY_VIEW);
  const [typing, setTyping] = useState(false);
  const [ctrl, setCtrl] = useState(false);
  const coarse = useMediaQuery(COARSE_POINTER);
  const touch = !compact;
  const live = useRef({ controlling, sendInput, view, ctrl });
  live.current = { controlling, sendInput, view, ctrl };

  useEffect(() => {
    if (!editingUrl) setDraftUrl(url);
  }, [url, editingUrl]);

  useEffect(() => {
    let pending: Frame | null = null;
    let drawing = false;
    const draw = async () => {
      const canvas = canvasRef.current;
      if (!canvas || !pending) {
        drawing = false;
        return;
      }
      const frame = pending;
      pending = null;
      try {
        const blob = await fetch(`data:image/jpeg;base64,${frame.jpegBase64}`).then((r) => r.blob());
        const bitmap = await createImageBitmap(blob);
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }
        sizeRef.current = { width: frame.width || bitmap.width, height: frame.height || bitmap.height };
        canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
        bitmap.close();
        setHasFrame(true);
        setDesktop(Boolean(frame.desktop));
      } catch {}
      if (pending) draw();
      else drawing = false;
    };
    return subscribeFrames((frame) => {
      pending = frame;
      if (!drawing) {
        drawing = true;
        draw();
      }
    });
  }, [subscribeFrames]);

  useEffect(() => {
    if (controlling && !coarse) canvasRef.current?.focus();
    if (!controlling) {
      setTyping(false);
      setCtrl(false);
      keysRef.current?.blur();
    }
  }, [controlling, coarse]);

  const point = useCallback((e: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const { width, height } = sizeRef.current;
    const scaleX = (width || canvas.width) / rect.width;
    const scaleY = (height || canvas.height) / rect.height;
    return {
      x: Math.round((e.clientX - rect.left) * scaleX),
      y: Math.round((e.clientY - rect.top) * scaleY),
    };
  }, []);

  const fitBox = useCallback(() => {
    const canvas = canvasRef.current;
    return { width: canvas?.offsetWidth ?? 0, height: canvas?.offsetHeight ?? 0 };
  }, []);

  const scroll = useRef<{ deltaX: number; deltaY: number; at: { clientX: number; clientY: number } | null; timer: number | null }>({ deltaX: 0, deltaY: 0, at: null, timer: null });

  const flushScroll = useCallback(() => {
    const pending = scroll.current;
    pending.timer = null;
    if (!pending.at || Math.abs(pending.deltaY) < 1) return;
    live.current.sendInput({ kind: "mouse", action: "wheel", deltaY: Math.round(pending.deltaY), ...point(pending.at) });
    pending.deltaY = 0;
  }, [point]);

  const onGesture = useCallback(
    (action: GestureAction) => {
      const { controlling: inControl, sendInput: send, view: current } = live.current;
      if (action.type === "pinch") {
        const stage = stageRef.current?.getBoundingClientRect();
        if (!stage) return;
        const focus = { x: action.centerX - (stage.left + stage.width / 2), y: action.centerY - (stage.top + stage.height / 2) };
        const box = fitBox();
        setView((before) => panBy(zoomAt(before, action.factor, focus, box), action.panX, action.panY, box));
        return;
      }
      if (action.type === "drag") {
        if (!inControl) {
          if (current.scale > 1) setView((before) => panBy(before, action.dx, action.dy, fitBox()));
          return;
        }
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const ratio = (sizeRef.current.height || canvas.height) / Math.max(1, rect.height);
        const pending = scroll.current;
        pending.deltaY += -action.dy * ratio;
        pending.at = { clientX: action.x, clientY: action.y };
        if (pending.timer === null) pending.timer = window.setTimeout(flushScroll, SCROLL_INTERVAL_MS);
        return;
      }
      if (!inControl) return;
      const at = point({ clientX: action.x, clientY: action.y });
      const button = action.type === "contextClick" ? "right" : "left";
      if (action.type === "contextClick") navigator.vibrate?.(12);
      send({ kind: "mouse", action: "move", ...at });
      send({ kind: "mouse", action: "down", button, ...at });
      send({ kind: "mouse", action: "up", button, ...at });
    },
    [fitBox, flushScroll, point],
  );

  const onGestureRef = useRef(onGesture);
  onGestureRef.current = onGesture;
  const gestures = useRef<ReturnType<typeof createGestures> | null>(null);
  if (!gestures.current) gestures.current = createGestures((action) => onGestureRef.current(action));
  const pressTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
      if (scroll.current.timer !== null) window.clearTimeout(scroll.current.timer);
    },
    [],
  );

  useEffect(() => {
    if (!hasFrame) return;
    const onResize = () => setView((before) => panBy(before, 0, 0, fitBox()));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [hasFrame, fitBox]);

  const touchHandlers = touch
    ? {
        onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
          if (e.pointerType === "mouse" || !hasFrame) return;
          e.preventDefault();
          lastTouch.current = performance.now();
          e.currentTarget.setPointerCapture?.(e.pointerId);
          gestures.current?.down(e.pointerId, e.clientX, e.clientY, performance.now());
          if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
          pressTimer.current = window.setTimeout(() => gestures.current?.tick(performance.now()), LONG_PRESS_MS + 20);
        },
        onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
          if (e.pointerType === "mouse") return;
          lastTouch.current = performance.now();
          gestures.current?.move(e.pointerId, e.clientX, e.clientY);
        },
        onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => {
          if (e.pointerType === "mouse") return;
          lastTouch.current = performance.now();
          gestures.current?.up(e.pointerId);
          if (!gestures.current?.active && pressTimer.current !== null) {
            window.clearTimeout(pressTimer.current);
            pressTimer.current = null;
          }
        },
        onPointerCancel: (e: React.PointerEvent<HTMLDivElement>) => {
          if (e.pointerType === "mouse") return;
          gestures.current?.cancel();
        },
      }
    : {};

  const fromTouch = () => performance.now() - lastTouch.current < TOUCH_GRACE_MS;

  const handlers = controlling
    ? {
        onMouseMove: (e: React.MouseEvent) => {
          if (fromTouch()) return;
          const now = performance.now();
          if (now - lastMove.current < MOVE_INTERVAL_MS) return;
          lastMove.current = now;
          sendInput({ kind: "mouse", action: "move", ...point(e) });
        },
        onMouseDown: (e: React.MouseEvent) => {
          if (fromTouch()) return;
          e.preventDefault();
          canvasRef.current?.focus();
          sendInput({ kind: "mouse", action: "down", button: e.button === 2 ? "right" : "left", ...point(e) });
        },
        onMouseUp: (e: React.MouseEvent) => {
          if (fromTouch()) return;
          sendInput({ kind: "mouse", action: "up", button: e.button === 2 ? "right" : "left", ...point(e) });
        },
        onWheel: (e: React.WheelEvent) => {
          sendInput({ kind: "mouse", action: "wheel", deltaY: Math.round(e.deltaY), ...point(e) });
        },
        onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
        onKeyDown: (e: React.KeyboardEvent) => {
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") return;
          e.preventDefault();
          sendInput({
            kind: "key",
            action: "down",
            key: e.key,
            code: e.code,
            text: e.key.length === 1 && !e.metaKey && !e.ctrlKey ? e.key : undefined,
          });
        },
        onKeyUp: (e: React.KeyboardEvent) => {
          e.preventDefault();
          sendInput({ kind: "key", action: "up", key: e.key, code: e.code });
        },
        onPaste: (e: React.ClipboardEvent) => {
          const text = e.clipboardData.getData("text");
          if (text) sendInput({ kind: "key", action: "char", key: text, text });
        },
      }
    : {};

  function sendAll(events: InputEvent[]) {
    for (const event of events) sendInput(event);
  }

  function pressBarKey(key: BarKey) {
    sendAll(keyPress(key, ctrl));
    setCtrl(false);
  }

  function resetCapture(input: HTMLInputElement) {
    input.value = SENTINEL;
    input.setSelectionRange(SENTINEL.length, SENTINEL.length);
  }

  function toggleTyping() {
    const input = keysRef.current;
    if (!input) return;
    if (typing) {
      input.blur();
      return;
    }
    resetCapture(input);
    input.focus({ preventScroll: true });
  }

  function zoomBy(factor: number) {
    setView((before) => zoomAt(before, factor, { x: 0, y: 0 }, fitBox()));
  }

  const zoomed = view.scale > 1.01;
  const showTools = coarse && touch && (hasFrame || controlling);

  return (
    <div className={`screen ${desktop ? "is-desktop" : ""} ${controlling ? "controlling" : ""} ${compact ? "is-compact" : ""} ${zoomed ? "is-zoomed" : ""}`}>
      {desktop && label && <span className="screen-tag">{label}</span>}
      {!desktop && !compact && (
      <div className="chrome">
        <div className="dots">
          <i />
          <i />
          <i />
        </div>
        <form
          className="flex-1 min-w-0 flex"
          onSubmit={(e) => {
            e.preventDefault();
            const value = draftUrl.trim();
            if (!value) return;
            const target = /^https?:\/\//i.test(value) ? value : `https://${value}`;
            sendInput({ kind: "navigate", url: target });
            setEditingUrl(false);
            if (!coarse) canvasRef.current?.focus();
            else (e.currentTarget.querySelector("input") as HTMLInputElement | null)?.blur();
          }}
        >
          <input
            className="url"
            value={draftUrl}
            readOnly={!controlling}
            onFocus={() => setEditingUrl(true)}
            onBlur={() => setEditingUrl(false)}
            onChange={(e) => setDraftUrl(e.target.value)}
            aria-label="URL"
            enterKeyHint="go"
            inputMode="url"
            spellCheck={false}
          />
        </form>
        {label && <span className="who">{label}</span>}
      </div>
      )}
      <div ref={stageRef} className={`stage ${touch && hasFrame ? "is-touch" : ""}`} {...touchHandlers}>
        <canvas
          ref={canvasRef}
          tabIndex={controlling ? 0 : -1}
          className={hasFrame ? "" : "hidden"}
          style={{ cursor: controlling ? "default" : "auto", transform: zoomed ? `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.scale})` : undefined }}
          {...handlers}
        />
        {!hasFrame && (
          <div className="placeholder">
            <AgentFigure state={online ? "thinking" : "calm"} size={compact ? 36 : 56} look={look} />
            {online ? t.waitingFrame : t.offline}
          </div>
        )}
      </div>
      {touch && controlling && (
        <input
          ref={keysRef}
          className="kb-capture"
          defaultValue={SENTINEL}
          aria-label={t.keyboard}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="enter"
          onFocus={() => setTyping(true)}
          onBlur={() => setTyping(false)}
          onKeyDown={(e) => {
            if (isForwardedHardwareKey(e.key)) {
              e.preventDefault();
              sendAll(keyPress(e.key, ctrl || e.ctrlKey));
              setCtrl(false);
              return;
            }
            if ((e.ctrlKey || e.metaKey) && e.key.length === 1) {
              if (e.key.toLowerCase() === "v") return;
              e.preventDefault();
              sendAll(keyPress(e.key, true));
              setCtrl(false);
            }
          }}
          onInput={(e) => {
            const native = e.nativeEvent as globalThis.InputEvent;
            const soft = readSoftInput(native.inputType ?? "insertText", native.data ?? null);
            if (soft?.kind === "text") sendAll(typedText(soft.text, ctrl));
            if (soft?.kind === "key") sendAll(keyPress(soft.key, ctrl));
            if (soft) setCtrl(false);
            resetCapture(e.currentTarget);
          }}
          onPaste={(e) => {
            e.preventDefault();
            const text = e.clipboardData.getData("text");
            if (text) sendAll(typedText(text));
          }}
        />
      )}
      {showTools && (
        <div className="screen-tools">
          {controlling && (
            <KeyBar ctrl={ctrl} onCtrl={setCtrl} onKey={pressBarKey}>
              <button
                type="button"
                className={`keybar-key is-wide ${typing ? "is-on" : ""}`}
                aria-pressed={typing}
                onPointerDown={(e) => e.preventDefault()}
                onClick={toggleTyping}
              >
                <Keyboard size={16} aria-hidden />
                <span>{typing ? t.hideKeyboard : t.keyboard}</span>
              </button>
            </KeyBar>
          )}
          <div className="screen-zoom" role="group" aria-label={t.zoom}>
            <button type="button" className="keybar-key" aria-label={t.zoomOut} disabled={!zoomed} onClick={() => zoomBy(1 / ZOOM_STEP)}>
              <Minus size={16} aria-hidden />
            </button>
            {zoomed && (
              <button type="button" className="keybar-key" aria-label={t.zoomFit} onClick={() => setView(IDENTITY_VIEW)}>
                <Scan size={16} aria-hidden />
              </button>
            )}
            <button type="button" className="keybar-key" aria-label={t.zoomIn} onClick={() => zoomBy(ZOOM_STEP)}>
              <Plus size={16} aria-hidden />
            </button>
          </div>
          {controlling && <p className="screen-hint">{t.touchHint}</p>}
        </div>
      )}
    </div>
  );
}
