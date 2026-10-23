import Link from "next/link";
import { AgentFigure } from "@/components/AgentFigure";
import { NewTeamForm } from "@/components/teams/NewTeamForm";
import { messages } from "@/lib/messages";
import { requireUser } from "@/lib/session";
import { teamsFor } from "@/server/teams-store";

export default async function TeamsPage() {
  const user = await requireUser();
  const t = messages.teams;
  const teams = await teamsFor(user.id);
  return (
    <div className="page narrow">
      <div className="top">
        <div>
          <h1>{t.title}</h1>
          <p>{t.subtitle}</p>
        </div>
      </div>
      <div className="flex flex-col gap-5 py-5">
        <NewTeamForm startOpen={teams.length === 0} />
        {teams.length === 0 && <p className="text-smoke text-[13px] m-0">{t.empty}</p>}
        <ul className="m-0 p-0 list-none flex flex-col gap-3" aria-label={t.title}>
          {teams.map((team) => (
            <li key={team.id}>
              <Link href={`/teams/${team.id}`} className="card rm-card no-underline">
                <span className="tm-mark" aria-hidden>
                  {team.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 flex flex-col gap-0.5">
                  <span className="font-semibold text-[15px] tracking-[-0.015em] truncate text-white">{team.name}</span>
                  <span className="text-ash text-[12.5px] truncate">{team.description || t.counts(team.people, team.agents.length)}</span>
                </span>
                <span className="rm-stack" aria-hidden>
                  {team.agents.slice(0, 4).map((agent) => (
                    <span key={agent.id} className="rm-stack-item">
                      <AgentFigure size={30} look={agent.look} state={agent.state} live={false} />
                    </span>
                  ))}
                </span>
                <span className="pill">{t.roles[team.role]}</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
