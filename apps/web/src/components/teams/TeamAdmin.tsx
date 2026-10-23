"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { editTeam, removeFromTeam, removeTeam } from "@/app/actions/teams";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Field, Input } from "@/components/ui/controls";
import { PanelSection } from "@/components/workspace/PanelSection";
import { messages } from "@/lib/messages";

export function TeamAdmin({ teamId, admin, name, description, me }: { teamId: string; admin: boolean; name: string; description: string; me: string }) {
  const t = messages.teams;
  const router = useRouter();
  const [draftName, setDraftName] = useState(name);
  const [draftDescription, setDraftDescription] = useState(description);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const run = (work: () => Promise<{ ok: boolean; error?: string }>, after: () => void) => {
    setError(null);
    start(async () => {
      const result = await work();
      if (result.ok) after();
      else setError(result.error ?? messages.common.notFound);
    });
  };

  const leave = <ConfirmButton label={t.leave} question={t.leaveConfirm(name)} disabled={pending} onConfirm={() => run(() => removeFromTeam(teamId, me), () => router.push("/teams"))} />;

  if (!admin) {
    return (
      <div className="flex flex-col items-start gap-2">
        {leave}
        {error && <div className="text-[12.5px] text-coral">{error}</div>}
      </div>
    );
  }

  return (
    <PanelSection title={t.settingsTitle} hint={t.settingsHint} collapsible>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => editTeam(teamId, { name: draftName, description: draftDescription }), () => router.refresh());
        }}
      >
        <Field label={t.nameLabel}>
          <Input value={draftName} onChange={(e) => setDraftName(e.target.value)} maxLength={60} required />
        </Field>
        <Field label={t.descriptionLabel}>
          <Input value={draftDescription} onChange={(e) => setDraftDescription(e.target.value)} maxLength={200} />
        </Field>
        <button type="submit" className="btn pri sm self-start" disabled={pending || (draftName === name && draftDescription === description)}>
          {t.save}
        </button>
      </form>
      <div className="flex gap-2 flex-wrap">
        {leave}
        <ConfirmButton label={t.deleteTeam} question={t.deleteConfirm(name)} disabled={pending} onConfirm={() => run(() => removeTeam(teamId), () => router.push("/teams"))} />
      </div>
      {error && <div className="text-[12.5px] text-coral">{error}</div>}
    </PanelSection>
  );
}
