"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { bringToTeam, leaveTeamAgent } from "@/app/actions/teams";
import { Select } from "@/components/ui/Select";
import { PanelSection } from "@/components/workspace/PanelSection";
import { messages } from "@/lib/messages";

export type TeamSettings = {
  current: { id: string; name: string; owned: boolean } | null;
  options: { id: string; name: string; people: number }[];
  personal: string[];
  canBring: boolean;
  canRelease: boolean;
};

export function TeamSection({ agentId, agentName, data }: { agentId: string; agentName: string; data: TeamSettings }) {
  const t = messages.teams;
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [teamId, setTeamId] = useState(data.options[0]?.id ?? "");
  const [owned, setOwned] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (data.current) {
    const current = data.current;
    return (
      <PanelSection title={t.sectionTitle} hint={current.name} collapsible>
        <p className="m-0 text-[13px]">
          {current.owned ? t.ownedBy(agentName) : t.lentTo(agentName)}{" "}
          <Link href={`/teams/${current.id}`} className="text-mist">
            {current.name}
          </Link>
        </p>
        <p className="m-0 fld-hint">{current.owned ? t.ownedHint : t.lentHint}</p>
        {data.canRelease && (
          <button
            type="button"
            className="btn sec sm self-start"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const result = await leaveTeamAgent(agentId);
                if (result.ok) router.refresh();
                else setError(result.error);
              })
            }
          >
            {current.owned ? t.release : t.takeBack}
          </button>
        )}
        {error && <div className="text-[12.5px] text-coral">{error}</div>}
      </PanelSection>
    );
  }

  if (!data.canBring) return null;

  return (
    <PanelSection title={t.sectionTitle} hint={t.sectionHint} collapsible>
      {data.options.length === 0 ? (
        <p className="m-0 fld-hint">
          {t.noTeams}{" "}
          <Link href="/teams" className="text-mist">
            {t.createOne}
          </Link>
        </p>
      ) : !open ? (
        <>
          <p className="m-0 fld-hint">{t.bringHint(agentName)}</p>
          <button type="button" className="btn sec sm self-start" onClick={() => setOpen(true)}>
            {t.bring}
          </button>
        </>
      ) : (
        <form
          className="flex flex-col gap-3"
          aria-label={t.bringTitle(agentName)}
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            start(async () => {
              const result = await bringToTeam(agentId, teamId, owned);
              if (result.ok) router.refresh();
              else setError(result.error);
            });
          }}
        >
          <Select
            name="team"
            aria-label={t.whichTeam}
            value={teamId}
            onChange={setTeamId}
            options={data.options.map((team) => ({ value: team.id, label: team.name, description: t.people(team.people) }))}
          />
          <div className="tm-opts" role="radiogroup" aria-label={t.whoOwns}>
            <button type="button" role="radio" aria-checked={owned} className={`tm-opt ${owned ? "is-on" : ""}`} onClick={() => setOwned(true)}>
              <b>{t.teamOwns}</b>
              <span>{t.teamOwnsHint(agentName)}</span>
            </button>
            <button type="button" role="radio" aria-checked={!owned} className={`tm-opt ${!owned ? "is-on" : ""}`} onClick={() => setOwned(false)}>
              <b>{t.lend}</b>
              <span>{t.lendHint}</span>
            </button>
          </div>
          <ul className="tm-changes" aria-label={t.whatChanges}>
            <li>{t.changeTasks}</li>
            <li>{t.changeMemory(agentName)}</li>
            <li className={data.personal.length ? "is-warn" : undefined}>{data.personal.length ? t.changeConnectors(data.personal.join(", ")) : t.changeNoConnectors}</li>
            <li>{t.changeSubscription}</li>
          </ul>
          <div className="flex gap-2">
            <button type="submit" className="btn pri sm" disabled={pending || !teamId}>
              {t.bringTo(data.options.find((team) => team.id === teamId)?.name ?? "")}
            </button>
            <button type="button" className="btn sec sm" onClick={() => setOpen(false)}>
              {messages.common.cancel}
            </button>
          </div>
          {error && <div className="text-[12.5px] text-coral">{error}</div>}
        </form>
      )}
    </PanelSection>
  );
}
