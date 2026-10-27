"use client";

import { useState, useTransition, type KeyboardEvent } from "react";
import { setAgentBrainAccount } from "@/app/actions/agents";
import { Field, FieldGroup, Input } from "@/components/ui/controls";
import { Segmented } from "@/components/ui/Segmented";
import type { BrainAccountView } from "@/lib/brain-account";
import { messages } from "@/lib/messages";

const t = messages.brainAccount;

type Auth = BrainAccountView["auth"];

export function BrainKeyForm({
  agentId,
  saved,
  onSaved,
  onCancel,
}: {
  agentId: string;
  saved: BrainAccountView | null;
  onSaved: (account: BrainAccountView | null) => void;
  onCancel: () => void;
}) {
  const [url, setUrl] = useState(saved?.url ?? "");
  const [auth, setAuth] = useState<Auth>(saved?.auth ?? "x-api-key");
  const [key, setKey] = useState("");
  const [budget, setBudget] = useState(saved?.maxUsdPerTurn ? String(saved.maxUsdPerTurn) : "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = () =>
    start(async () => {
      setError(null);
      const result = await setAgentBrainAccount(agentId, { own: true, url, auth, key, maxUsdPerTurn: budget });
      if (!result.ok) return setError(result.error);
      setKey("");
      onSaved(result.account);
    });

  const onEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    submit();
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="fld-hint">{t.hint}</div>
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
        <button type="button" className="btn pri sm" onClick={submit} disabled={pending}>
          {t.save}
        </button>
        <button type="button" className="btn sec sm" onClick={onCancel} disabled={pending}>
          {t.cancel}
        </button>
      </span>
    </div>
  );
}
