"use client";

import { Check } from "lucide-react";
import { useState, useTransition, type KeyboardEvent } from "react";
import { setAgentBrainAccount } from "@/app/actions/agents";
import { Field, FieldGroup, Input } from "@/components/ui/controls";
import { Segmented } from "@/components/ui/Segmented";
import type { BrainAccountView } from "@/lib/brain-account";
import { messages } from "@/lib/messages";

const t = messages.brainAccount;

type Auth = BrainAccountView["auth"];

export function BrainAccountPicker({ agentId, initial, onOwnChange }: { agentId: string; initial: BrainAccountView | null; onOwnChange?: (own: boolean) => void }) {
  const [saved, setSaved] = useState(initial);
  const [own, setOwn] = useState(Boolean(initial));
  const [url, setUrl] = useState(initial?.url ?? "");
  const [auth, setAuth] = useState<Auth>(initial?.auth ?? "x-api-key");
  const [key, setKey] = useState("");
  const [budget, setBudget] = useState(initial?.maxUsdPerTurn ? String(initial.maxUsdPerTurn) : "");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();

  const submit = (keep: boolean) =>
    start(async () => {
      setDone(false);
      setError(null);
      const result = await setAgentBrainAccount(agentId, { own: keep, url, auth, key, maxUsdPerTurn: budget });
      if (!result.ok) return setError(result.error);
      setSaved(result.account);
      setKey("");
      setDone(true);
    });

  const choose = (value: "signed_in" | "own") => {
    const next = value === "own";
    setOwn(next);
    onOwnChange?.(next);
    setDone(false);
    setError(null);
    if (!next && saved) submit(false);
  };

  const onEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    submit(true);
  };

  return (
    <div className="flex flex-col gap-2">
      <Segmented
        label={t.title}
        options={[
          { value: "signed_in", label: t.signedIn },
          { value: "own", label: t.own },
        ]}
        value={own ? "own" : "signed_in"}
        onChange={choose}
        disabled={pending}
      />
      <div className="fld-hint">{own ? t.ownHint : t.signedInHint}</div>
      {own && (
        <div className="flex flex-col gap-3 max-w-[480px] pt-1">
          <Field label={t.urlLabel} hint={t.urlHint}>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={onEnter} placeholder={t.urlPlaceholder} inputMode="url" autoComplete="off" spellCheck={false} maxLength={500} />
          </Field>
          {url.trim() !== "" && (
            <FieldGroup label={t.authLabel}>
              <Segmented
                label={t.authLabel}
                variant="chips"
                options={(["x-api-key", "bearer"] as Auth[]).map((value) => ({ value, label: t.auth[value] }))}
                value={auth}
                onChange={setAuth}
                disabled={pending}
              />
            </FieldGroup>
          )}
          <Field label={t.keyLabel} hint={saved?.last4 ? t.keySaved(saved.last4) : undefined}>
            <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={onEnter} placeholder={t.keyPlaceholder} autoComplete="new-password" spellCheck={false} maxLength={400} />
          </Field>
          <Field label={t.budgetLabel} hint={t.budgetHint} error={error ?? undefined}>
            <Input value={budget} onChange={(e) => setBudget(e.target.value)} onKeyDown={onEnter} placeholder={t.budgetPlaceholder} inputMode="decimal" autoComplete="off" maxLength={10} className="max-w-[160px]" />
          </Field>
          <span className="flex items-center gap-2">
            <button type="button" className="btn pri sm" onClick={() => submit(true)} disabled={pending}>
              {t.save}
            </button>
            <span className="w-4 flex-none" aria-live="polite">
              {done && <Check size={16} className="text-green" aria-label={t.saved} />}
            </span>
          </span>
        </div>
      )}
    </div>
  );
}
