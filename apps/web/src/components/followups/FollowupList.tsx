"use client";

import { AlarmClock } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { cancelFollowupAction } from "@/app/actions/followups";
import { messages } from "@/lib/messages";

export type FollowupSummary = {
  id: string;
  agentName?: string;
  when: string;
  note: string;
  task: string | null;
  status: string;
  canCancel: boolean;
};

const STATUS_PILL: Record<string, string> = { pending: "s", fired: "g", cancelled: "", stopped: "c" };

export function FollowupList({ items, showStatus = false, compact = false }: { items: FollowupSummary[]; showStatus?: boolean; compact?: boolean }) {
  const t = messages.followups;
  const router = useRouter();
  const [gone, setGone] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const shown = items.filter((item) => !gone.has(item.id));

  const cancel = (id: string) => {
    setBusy(id);
    setFailed(null);
    startTransition(async () => {
      const result = await cancelFollowupAction(id).catch(() => ({ ok: false as const }));
      setBusy(null);
      if (!result.ok) {
        setFailed(id);
        return;
      }
      setGone((previous) => new Set(previous).add(id));
      router.refresh();
    });
  };

  return (
    <ul className="m-0 p-0 list-none flex flex-col">
      {shown.map((item) => (
        <li key={item.id} className="border-t border-graphite first:border-0">
          <div className={compact ? "flex items-start gap-2.5 py-2" : "ws-row items-start flex-wrap gap-y-1.5"}>
            {!compact && <AlarmClock size={16} className="flex-none text-ash mt-0.5" aria-hidden />}
            <span className={compact ? "flex-1 min-w-0 flex flex-col gap-0.5" : "flex-1 min-w-[160px] flex flex-col gap-0.5"}>
              <span className={compact ? "text-[12.5px] line-clamp-2" : "text-[13px] break-words"} title={compact ? item.note : undefined}>
                {item.agentName ? <b className="font-medium">{item.agentName} · </b> : null}
                {item.note}
              </span>
              <span className="text-[12px] text-smoke" suppressHydrationWarning>
                {item.when} · {item.task ? t.task(item.task) : t.inChat}
              </span>
              {failed === item.id && (
                <span className="text-[12px] text-coral" role="alert">
                  {t.cancelFailed}
                </span>
              )}
            </span>
            {showStatus && <span className={`pill ${STATUS_PILL[item.status] ?? ""}`}>{t.status[item.status] ?? item.status}</span>}
            {item.canCancel && item.status === "pending" && (
              <button type="button" className="btn sec sm" disabled={busy === item.id} onClick={() => cancel(item.id)} aria-label={`${t.cancel}: ${item.note}`}>
                {busy === item.id ? t.cancelling : t.cancel}
              </button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
