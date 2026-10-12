"use client";

import { Fragment } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CornerDownLeft, Delete } from "lucide-react";
import { messages } from "@/lib/messages";
import { BAR_KEYS, type BarKey } from "./remote-keys";

const ICONS: Partial<Record<BarKey, typeof ArrowUp>> = {
  ArrowLeft,
  ArrowUp,
  ArrowDown,
  ArrowRight,
  Backspace: Delete,
  Enter: CornerDownLeft,
};

const TEXT: Partial<Record<BarKey, string>> = { Escape: "Esc", Tab: "Tab" };

export function KeyBar({ ctrl, onCtrl, onKey, children }: { ctrl: boolean; onCtrl: (on: boolean) => void; onKey: (key: BarKey) => void; children?: React.ReactNode }) {
  const t = messages.live.keys;
  const keep = (event: React.PointerEvent) => event.preventDefault();
  return (
    <div className="keybar" role="toolbar" aria-label={t.label}>
      {children}
      {BAR_KEYS.map((key, index) => {
        const Icon = ICONS[key];
        return (
          <Fragment key={key}>
            {index === 2 && (
              <button type="button" className={`keybar-key ${ctrl ? "is-on" : ""}`} aria-pressed={ctrl} aria-label={t.Control} onPointerDown={keep} onClick={() => onCtrl(!ctrl)}>
                Ctrl
              </button>
            )}
            <button type="button" className="keybar-key" aria-label={t[key]} onPointerDown={keep} onClick={() => onKey(key)}>
              {Icon ? <Icon size={16} aria-hidden /> : TEXT[key]}
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}
