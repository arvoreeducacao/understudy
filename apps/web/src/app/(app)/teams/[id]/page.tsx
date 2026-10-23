import Link from "next/link";
import { notFound } from "next/navigation";
import type { CSSProperties } from "react";
import { AgentFigure } from "@/components/AgentFigure";
import { AutoRefresh } from "@/components/AutoRefresh";
import { TeamAdmin } from "@/components/teams/TeamAdmin";
import { TeamPeople } from "@/components/teams/TeamPeople";
import { cleanLook } from "@/lib/look";
import { messages } from "@/lib/messages";
import { requireUser } from "@/lib/session";
import { STATE_PILL } from "@/lib/state-pill";
import { loadTeam } from "@/server/teams-store";

export default async function TeamPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const data = await loadTeam(id, user.id);
  if (!data) notFound();
  const t = messages.teams;
  const admin = data.role === "admin";
  return (
    <div className="page wide">
      <AutoRefresh seconds={20} />
      <div className="top">
        <div className="flex items-center gap-3.5 min-w-0">
          <span className="tm-mark lg" aria-hidden>
            {data.team.name.slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0">
            <h1 className="truncate">{data.team.name}</h1>
            <p>{data.team.description || t.counts(data.people.length, data.agents.length)}</p>
          </div>
        </div>
      </div>

      <div className="tm-grid py-6">
        <div className="flex flex-col gap-6 min-w-0">
          <section aria-labelledby="team-agents">
            <h2 id="team-agents" className="tm-h2">
              {t.agentsTitle} <span>{t.agentsHint(data.team.name)}</span>
            </h2>
            {data.agents.length === 0 ? (
              <div className="card p-[18px] text-smoke text-[13px]">{t.noAgents}</div>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
                {data.agents.map((agent) => (
                  <Link key={agent.id} href={`/agents/${agent.id}`} className="card tm-agent no-underline" style={{ "--tint": cleanLook(agent.look).color } as CSSProperties}>
                    <AgentFigure size={52} look={agent.look} state={agent.state} live={false} />
                    <span className="min-w-0 flex flex-col gap-1">
                      <b className="text-white font-semibold text-[14.5px] truncate">{agent.name}</b>
                      <span className="text-smoke text-[12px] truncate">{agent.role}</span>
                      <span className={`pill ${STATE_PILL[agent.state]} self-start`}>
                        <span className="dot" />
                        {agent.note ? agent.note.slice(0, 40) : messages.states[agent.state]}
                      </span>
                      <span className="text-smoke text-[11.5px] truncate">
                        {agent.teamOwned ? t.runsOn(agent.ownerName.split(" ")[0]) : t.lentShort(agent.ownerName.split(" ")[0])}
                      </span>
                    </span>
                  </Link>
                ))}
              </div>
            )}
            {data.agents.length > 0 && <p className="m-0 mt-2.5 fld-hint">{t.addAgentHint}</p>}
          </section>

          <section aria-labelledby="team-connectors">
            <h2 id="team-connectors" className="tm-h2">
              {t.connectorsTitle} <span>{t.connectorsHint}</span>
            </h2>
            {data.connectors.length === 0 ? (
              <div className="card p-[18px] text-smoke text-[13px]">{t.noConnectors}</div>
            ) : (
              <ul className="card st-list p-[14px_18px]">
                {data.connectors.map((connector) => (
                  <li key={connector.id}>
                    <span className="tm-letter" aria-hidden>
                      {connector.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{connector.name}</span>
                    <span className="text-smoke text-[12px] truncate">{connector.agents.join(", ")}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className="flex flex-col gap-6 min-w-0">
          <section aria-labelledby="team-people">
            <h2 id="team-people" className="tm-h2">
              {t.peopleTitle} <span>{data.people.length}</span>
            </h2>
            <TeamPeople teamId={data.team.id} me={user.id} admin={admin} people={data.people} />
          </section>
          <div className="card tm-note">
            <b>{t.rulesTitle}</b> {t.rulesBody}
          </div>
          <TeamAdmin teamId={data.team.id} admin={admin} name={data.team.name} description={data.team.description} me={user.id} />
        </div>
      </div>
    </div>
  );
}
