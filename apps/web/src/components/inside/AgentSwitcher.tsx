"use client";

import { Check, LayoutGrid, Plus, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef } from "react";
import type { AgentState } from "@understudy/protocol";
import { AgentFigure } from "@/components/AgentFigure";
import { messages } from "@/lib/messages";
import { railLine, type RailData } from "./AgentRail";

export function AgentSwitcher({ open, onClose, data, currentId, current }: { open: boolean; onClose: () => void; data: RailData; currentId: string; current: { state: AgentState; note: string | null } }) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const r = messages.agentPage;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="sheet sw-sheet"
      aria-label={r.switchAgent}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="sheet-body">
        <div className="flex items-center gap-3">
          <h2 className="m-0 flex-1 text-[16px] font-semibold text-white">{r.switchAgent}</h2>
          <button type="button" className="cx-back" aria-label={messages.common.close} onClick={onClose}>
            <X size={17} aria-hidden />
          </button>
        </div>
        <ul className="sw-list scroll-thin">
          {data.agents.map((agent) => {
            const on = agent.id === currentId;
            const live = on ? { ...agent, ...current } : agent;
            return (
              <li key={agent.id}>
                <Link href={`/agents/${agent.id}`} className={`sw-agent ${on ? "is-on" : ""}`} aria-current={on ? "page" : undefined} onClick={on ? onClose : undefined}>
                  <span className="ar-fig">
                    <AgentFigure size={34} look={agent.look} state={live.state} live={on} />
                    {agent.waiting > 0 && <span className="ar-badge">{agent.waiting}</span>}
                  </span>
                  <span className="ar-meta">
                    <span className="ar-name">{agent.name}</span>
                    <span className="ar-line">{railLine(live)}</span>
                  </span>
                  {on && <Check size={16} className="sw-check" aria-hidden />}
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="sw-foot">
          <Link href="/" className="btn sec">
            <LayoutGrid size={15} aria-hidden />
            {r.allAgents}
          </Link>
          <Link href="/agents/new" className="btn sec">
            <Plus size={15} aria-hidden />
            {r.newAgent}
          </Link>
        </div>
      </div>
    </dialog>
  );
}
