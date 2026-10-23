"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { changeTeamRole, inviteToTeam, removeFromTeam } from "@/app/actions/teams";
import { Input } from "@/components/ui/controls";
import { Select } from "@/components/ui/Select";
import type { TeamRole } from "@/lib/db/schema";
import { messages } from "@/lib/messages";

type Person = { userId: string; name: string; email: string; role: TeamRole };

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

export function TeamPeople({ teamId, me, admin, people }: { teamId: string; me: string; admin: boolean; people: Person[] }) {
  const t = messages.teams;
  const router = useRouter();
  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("member");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const run = (work: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) => {
    setError(null);
    start(async () => {
      const result = await work();
      if (!result.ok) {
        setError(result.error ?? messages.common.notFound);
        return;
      }
      after?.();
      router.refresh();
    });
  };

  const roleOptions = [
    { value: "member", label: t.roles.member, description: t.roleHints.member },
    { value: "admin", label: t.roles.admin, description: t.roleHints.admin },
  ];

  return (
    <div className="card p-[14px_18px] flex flex-col gap-3">
      <ul className="st-list">
        {people.map((person) => (
          <li key={person.userId}>
            <span className="tm-av" aria-hidden>
              {initials(person.name || person.email)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate">{person.name}</span>
              <span className="block text-smoke text-[12px] truncate">{person.userId === me ? t.you : person.email}</span>
            </span>
            {admin ? (
              <Select
                className="!w-[118px] flex-none"
                aria-label={t.roleOf(person.name)}
                value={person.role}
                onChange={(next) => next !== person.role && run(() => changeTeamRole(teamId, person.userId, next))}
                options={roleOptions}
              />
            ) : (
              <span className={`pill ${person.role === "admin" ? "a" : ""}`}>{t.roles[person.role]}</span>
            )}
            {admin && person.userId !== me && (
              <button type="button" className="btn sec sm" disabled={pending} onClick={() => run(() => removeFromTeam(teamId, person.userId))}>
                {t.remove}
              </button>
            )}
          </li>
        ))}
      </ul>
      {admin &&
        (inviting ? (
          <form
            className="flex flex-col gap-2.5"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => inviteToTeam(teamId, { email, role }), () => {
                setEmail("");
                setInviting(false);
              });
            }}
          >
            <div className="flex gap-2 flex-wrap">
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="flex-1 min-w-[180px]" placeholder={t.email} aria-label={t.email} required autoFocus />
              <Select className="!w-[130px] flex-none" aria-label={t.role} value={role} onChange={setRole} options={roleOptions} />
            </div>
            <p className="m-0 fld-hint">{t.inviteHint}</p>
            <div className="flex gap-2">
              <button type="submit" className="btn pri sm" disabled={pending}>
                {t.add}
              </button>
              <button type="button" className="btn sec sm" onClick={() => setInviting(false)}>
                {messages.common.cancel}
              </button>
            </div>
          </form>
        ) : (
          <button type="button" className="btn sec sm self-start" onClick={() => setInviting(true)}>
            {t.invite}
          </button>
        ))}
      {error && <div className="text-[12.5px] text-coral">{error}</div>}
    </div>
  );
}
