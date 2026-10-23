"use client";

import { Check, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { openRoom } from "@/app/actions/rooms";
import { AgentFigure } from "@/components/AgentFigure";
import { Field, FieldGroup, Input } from "@/components/ui/controls";
import { Select } from "@/components/ui/Select";
import type { Look } from "@/lib/look";
import { messages } from "@/lib/messages";
import { ROOM_LIMITS } from "@/lib/rooms";

type Pickable = { id: string; name: string; role: string; look: Look };

export type RoomScope = { id: string; label: string; agents: Pickable[]; people: { id: string; name: string }[] };

export function NewRoomForm({
  scopes,
  me,
  startOpen,
  initialScope = "",
  initialPicked = [],
}: {
  scopes: RoomScope[];
  me: string;
  startOpen: boolean;
  initialScope?: string;
  initialPicked?: string[];
}) {
  const t = messages.rooms;
  const router = useRouter();
  const [open, setOpen] = useState(startOpen);
  const [scopeId, setScopeId] = useState(scopes.some((scope) => scope.id === initialScope) ? initialScope : (scopes[0]?.id ?? ""));
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>(initialPicked);
  const [people, setPeople] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const scope = scopes.find((item) => item.id === scopeId) ?? scopes[0];
  const team = Boolean(scope?.id);
  const min = team ? ROOM_LIMITS.minTeamParticipants : ROOM_LIMITS.minParticipants;

  if (!open || !scope) {
    return (
      <button type="button" className="btn pri self-start" onClick={() => setOpen(true)} disabled={!scope}>
        <Plus size={15} aria-hidden />
        {t.newRoom}
      </button>
    );
  }

  const toggle = (id: string) => setPicked((list) => (list.includes(id) ? list.filter((x) => x !== id) : list.length >= ROOM_LIMITS.maxParticipants ? list : [...list, id]));
  const togglePerson = (id: string) => setPeople((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));
  const chosen = picked.filter((id) => scope.agents.some((agent) => agent.id === id));
  const ready = name.trim().length > 0 && chosen.length >= min;

  return (
    <form
      className="card p-[18px] flex flex-col gap-4"
      aria-label={t.newRoom}
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const result = await openRoom({ name, agentIds: chosen, ...(team ? { teamId: scope.id, peopleIds: people } : {}) });
          if (result.ok) router.push(`/rooms/${result.id}`);
          else setError(result.error);
        });
      }}
    >
      <h2 className="m-0 text-[15px] font-semibold tracking-[-0.015em]">{t.newRoom}</h2>
      {scopes.length > 1 && (
        <Field label={t.whereLabel} hint={team ? t.whereTeamHint : t.whereMineHint}>
          <Select
            aria-label={t.whereLabel}
            value={scope.id}
            onChange={(value) => {
              setScopeId(value);
              setPicked([]);
              setPeople([]);
            }}
            options={scopes.map((item) => ({ value: item.id, label: item.label }))}
          />
        </Field>
      )}
      <Field label={t.nameLabel}>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={team ? t.teamNamePlaceholder : t.namePlaceholder} maxLength={ROOM_LIMITS.nameMax} required />
      </Field>
      <FieldGroup label={t.whoLabel} hint={team ? t.whoTeamHint(ROOM_LIMITS.maxParticipants) : t.whoHint(ROOM_LIMITS.minParticipants, ROOM_LIMITS.maxParticipants)}>
        {scope.agents.length === 0 ? (
          <p className="m-0 fld-hint">{t.noTeamAgents}</p>
        ) : (
          <div className="rm-picks">
            {scope.agents.map((agent) => {
              const on = picked.includes(agent.id);
              return (
                <button key={agent.id} type="button" className={`rm-pick ${on ? "is-on" : ""}`} aria-pressed={on} onClick={() => toggle(agent.id)}>
                  <span className="rm-pick-check" aria-hidden>
                    {on && <Check size={12} strokeWidth={3} />}
                  </span>
                  <AgentFigure size={46} look={agent.look} live={false} />
                  <span className="rm-pick-name">{agent.name}</span>
                  {agent.role && <span className="rm-pick-role">{agent.role}</span>}
                </button>
              );
            })}
          </div>
        )}
      </FieldGroup>
      {team && scope.people.length > 1 && (
        <FieldGroup label={t.peopleLabel} hint={t.peopleHint}>
          <div className="flex flex-wrap gap-2">
            {scope.people
              .filter((person) => person.id !== me)
              .map((person) => {
                const on = people.includes(person.id);
                return (
                  <button key={person.id} type="button" className="rm-chip" aria-pressed={on} onClick={() => togglePerson(person.id)}>
                    {on && <Check size={12} strokeWidth={3} aria-hidden />}
                    {person.name}
                  </button>
                );
              })}
          </div>
        </FieldGroup>
      )}
      {error && (
        <div className="err" role="alert">
          {error}
        </div>
      )}
      <div className="flex gap-2 justify-end">
        {!startOpen && (
          <button type="button" className="btn sec" onClick={() => setOpen(false)}>
            {messages.common.cancel}
          </button>
        )}
        <button type="submit" className="btn pri" disabled={!ready || pending}>
          {pending ? t.creating : t.create}
        </button>
      </div>
    </form>
  );
}
