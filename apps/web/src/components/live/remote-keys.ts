import type { InputEvent } from "@understudy/protocol";

export const BAR_KEYS = ["Escape", "Tab", "ArrowLeft", "ArrowUp", "ArrowDown", "ArrowRight", "Backspace", "Enter"] as const;

export type BarKey = (typeof BAR_KEYS)[number];

type KeyEvent = Extract<InputEvent, { kind: "key" }>;

const CODES: Record<string, string> = {
  Escape: "Escape",
  Tab: "Tab",
  Enter: "Enter",
  Backspace: "Backspace",
  ArrowLeft: "ArrowLeft",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowRight: "ArrowRight",
  Control: "ControlLeft",
};

function codeFor(key: string) {
  if (CODES[key]) return CODES[key];
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return undefined;
}

function keyEvent(action: "down" | "up", key: string, text?: string): KeyEvent {
  const code = codeFor(key);
  return { kind: "key", action, key, ...(code ? { code } : {}), ...(text ? { text } : {}) };
}

export function keyPress(key: string, ctrl = false): KeyEvent[] {
  if (ctrl) {
    const target = key.length === 1 ? key.toLowerCase() : key;
    return [keyEvent("down", "Control"), keyEvent("down", target), keyEvent("up", target), keyEvent("up", "Control")];
  }
  const text = key.length === 1 ? key : undefined;
  return [keyEvent("down", key, text), keyEvent("up", key)];
}

export function typedText(text: string, ctrl = false): KeyEvent[] {
  if (!text) return [];
  if (ctrl) return [...text].flatMap((char) => keyPress(char, true));
  return [{ kind: "key", action: "char", key: text, text }];
}

export type SoftInput = { kind: "text"; text: string } | { kind: "key"; key: BarKey } | null;

export function readSoftInput(inputType: string, data: string | null): SoftInput {
  if (inputType === "insertLineBreak" || inputType === "insertParagraph") return { kind: "key", key: "Enter" };
  if (inputType === "deleteContentBackward" || inputType === "deleteWordBackward") return { kind: "key", key: "Backspace" };
  if (inputType.startsWith("insert") && data) return data === "\n" ? { kind: "key", key: "Enter" } : { kind: "text", text: data };
  return null;
}

export function isForwardedHardwareKey(key: string) {
  return (BAR_KEYS as readonly string[]).includes(key) || key === "Delete" || key === "Home" || key === "End" || key === "PageUp" || key === "PageDown";
}

const TERMINAL_SEQUENCES: Record<BarKey, string> = {
  Escape: "\x1b",
  Tab: "\t",
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowRight: "\x1b[C",
  ArrowLeft: "\x1b[D",
  Backspace: "\x7f",
  Enter: "\r",
};

export function terminalSequence(key: BarKey) {
  return TERMINAL_SEQUENCES[key];
}

export function terminalCtrl(char: string) {
  const upper = char.toUpperCase();
  const code = upper.charCodeAt(0);
  if (upper.length !== 1 || code < 64 || code > 95) return char;
  return String.fromCharCode(code - 64);
}
