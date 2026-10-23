"use client";

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { openTeam } from "@/app/actions/teams";
import { Field, Input } from "@/components/ui/controls";
import { messages } from "@/lib/messages";

export function NewTeamForm({ startOpen }: { startOpen: boolean }) {
  const t = messages.teams;
  const router = useRouter();
  const [open, setOpen] = useState(startOpen);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (!open) {
    return (
      <button type="button" className="btn pri self-start" onClick={() => setOpen(true)}>
        <Plus size={15} aria-hidden />
        {t.newTeam}
      </button>
    );
  }

  return (
    <form
      className="card p-[18px] flex flex-col gap-4"
      aria-label={t.newTeam}
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const result = await openTeam({ name, description });
          if (result.ok) router.push(`/teams/${result.id}`);
          else setError(result.error);
        });
      }}
    >
      <h2 className="m-0 text-[15px] font-semibold tracking-[-0.015em]">{t.newTeam}</h2>
      <Field label={t.nameLabel}>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t.namePlaceholder} maxLength={60} required />
      </Field>
      <Field label={t.descriptionLabel} hint={t.descriptionHint}>
        <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t.descriptionPlaceholder} maxLength={200} />
      </Field>
      <p className="m-0 fld-hint">{t.createHint}</p>
      {error && <div className="text-[12.5px] text-coral">{error}</div>}
      <div className="flex gap-2">
        <button type="submit" className="btn pri" disabled={pending || !name.trim()}>
          {pending ? t.creating : t.create}
        </button>
        <button type="button" className="btn sec" onClick={() => setOpen(false)}>
          {messages.common.cancel}
        </button>
      </div>
    </form>
  );
}
