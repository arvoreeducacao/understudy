"use client";

import { X } from "lucide-react";
import { useState, useTransition } from "react";
import { APPROVAL_FALLBACKS, type ApprovalAllow, type ApprovalFallback, type ApprovalMode, type ApprovalPolicy } from "@understudy/protocol";
import { setAgentApprovalPolicy } from "@/app/actions/agents";
import { Radio } from "@/components/ui/controls";
import { Segmented } from "@/components/ui/Segmented";
import { messages } from "@/lib/messages";

export const OFFERED_MODES: ApprovalMode[] = ["always", "on-miss", "off"];

type Change = { mode?: ApprovalMode; fallback?: ApprovalFallback; remove?: ApprovalAllow };

export function ApprovalModesEditor({ agentId, initial }: { agentId: string; initial: ApprovalPolicy }) {
  const t = messages.approvalModes;
  const [policy, setPolicy] = useState(initial);
  const [status, setStatus] = useState<"idle" | "saved" | "failed">("idle");
  const [pending, start] = useTransition();
  const modes = OFFERED_MODES.includes(policy.mode) ? OFFERED_MODES : [...OFFERED_MODES, policy.mode];

  const save = (change: Change) => {
    setStatus("idle");
    start(async () => {
      const result = await setAgentApprovalPolicy(agentId, change);
      if (!result.ok) {
        setStatus("failed");
        return;
      }
      setPolicy(result.policy);
      setStatus("saved");
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
        <legend className="fld-label mb-1.5">{t.modeLabel}</legend>
        {modes.map((mode) => (
          <Radio
            key={mode}
            name={`approval-mode-${agentId}`}
            value={mode}
            checked={policy.mode === mode}
            disabled={pending}
            onChange={() => save({ mode })}
            label={t.modes[mode].name}
            hint={t.modes[mode].hint}
          />
        ))}
      </fieldset>

      <div className="fld">
        <span className="fld-label">{t.listLabel}</span>
        {policy.allow.length === 0 ? (
          <p className="m-0 fld-hint">{t.listEmpty}</p>
        ) : (
          <ul className="st-list">
            {policy.allow.map((entry) => (
              <li key={`${entry.kind}:${entry.value}`}>
                <span className="pill flex-none">{t.kinds[entry.kind]}</span>
                <span className="flex-1 min-w-0 break-words">{entry.value}</span>
                <button type="button" className="btn sec sm !px-2" aria-label={t.remove(entry.value)} title={t.remove(entry.value)} disabled={pending} onClick={() => save({ remove: entry })}>
                  <X size={14} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="fld">
        <span className="fld-label">{t.fallbackLabel}</span>
        <Segmented
          label={t.fallbackLabel}
          options={APPROVAL_FALLBACKS.map((fallback) => ({ value: fallback, label: t.fallbacks[fallback].name }))}
          value={policy.fallback}
          disabled={pending}
          onChange={(fallback) => {
            if (fallback !== policy.fallback) save({ fallback });
          }}
        />
        <div className="fld-hint">{t.fallbacks[policy.fallback].hint}</div>
      </div>

      {status === "saved" && (
        <span className="text-[12.5px] text-green" role="status">
          {t.saved}
        </span>
      )}
      {status === "failed" && (
        <span className="text-[12.5px] text-coral" role="alert">
          {t.failed}
        </span>
      )}
    </div>
  );
}
