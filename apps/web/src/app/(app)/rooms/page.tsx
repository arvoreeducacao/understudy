import Link from "next/link";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { AgentFigure } from "@/components/AgentFigure";
import { AutoRefresh } from "@/components/AutoRefresh";
import { NewRoomForm, type RoomScope } from "@/components/rooms/NewRoomForm";
import { accessibleAgentIds } from "@/lib/access";
import { getDb, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { formatWhen } from "@/lib/format";
import type { Look } from "@/lib/look";
import { messages } from "@/lib/messages";
import { ROOM_LIMITS } from "@/lib/rooms";
import { requireUser } from "@/lib/session";
import { listPairs } from "@/server/pair-threads";
import { listRooms } from "@/server/room-store";
import { teamsFor } from "@/server/teams-store";

type Face = { id: string; name: string; look: Look; state: (typeof schema.agents.$inferSelect)["state"] };

type Item = {
  key: string;
  href: string;
  title: string;
  people: string;
  faces: Face[];
  author: string | null;
  line: string;
  at: Date;
  tag: string;
  teamTag: boolean;
  stopped: boolean;
  teamId: string | null;
  mine: boolean;
};

function pairLine(kind: string, text: string, task: string | null) {
  const t = messages.rooms;
  if (kind === "stop") return t.pairStoppedLine;
  if (kind === "resume") return t.pairResumedLine;
  if (kind === "handoff") return `${t.handoff(task ?? "")}: ${text}`;
  return text;
}

function hrefWith(params: { tab?: string; team?: string }) {
  const search = new URLSearchParams();
  if (params.tab) search.set("tab", params.tab);
  if (params.team) search.set("team", params.team);
  const query = search.toString();
  return query ? `/rooms?${query}` : "/rooms";
}

export default async function ConversationsPage({ searchParams }: { searchParams: Promise<{ with?: string; tab?: string; team?: string }> }) {
  const user = await requireUser();
  const t = messages.rooms;
  const db = getDb();
  const query = await searchParams;
  const tab = query.tab === "between" ? "between" : "groups";
  const [rooms, agents, visible, teams] = await Promise.all([
    listRooms(user.id),
    db
      .select({ id: schema.agents.id, name: schema.agents.name, role: schema.agents.role, look: schema.agents.look, teamId: schema.agents.teamId })
      .from(schema.agents)
      .where(eq(schema.agents.ownerId, user.id))
      .orderBy(desc(schema.agents.createdAt)),
    accessibleAgentIds(user.id),
    teamsFor(user.id),
  ]);
  const teamIds = teams.map((team) => team.id);
  const [teamAgents, teamPeople] = teamIds.length
    ? await Promise.all([
        db
          .select({ id: schema.agents.id, name: schema.agents.name, role: schema.agents.role, look: schema.agents.look, teamId: schema.agents.teamId })
          .from(schema.agents)
          .where(inArray(schema.agents.teamId, teamIds))
          .orderBy(asc(schema.agents.name)),
        db
          .select({ teamId: schema.teamMembers.teamId, id: schema.user.id, name: schema.user.name })
          .from(schema.teamMembers)
          .innerJoin(schema.user, eq(schema.user.id, schema.teamMembers.userId))
          .where(inArray(schema.teamMembers.teamId, teamIds))
          .orderBy(asc(schema.user.name)),
      ])
    : [[], []];
  const pairs = await listPairs(visible, 500, user.id);
  const pairAgentIds = [...new Set(pairs.flatMap((pair) => pair.ids))];
  const pairAgents = pairAgentIds.length
    ? await db
        .select({ id: schema.agents.id, name: schema.agents.name, look: schema.agents.look, state: schema.agents.state, teamId: schema.agents.teamId, ownerId: schema.agents.ownerId })
        .from(schema.agents)
        .where(inArray(schema.agents.id, pairAgentIds))
    : [];
  const byId = new Map(pairAgents.map((agent) => [agent.id, agent]));
  const teamName = new Map(teams.map((team) => [team.id, team.name]));

  const groups: Item[] = rooms.map((room) => {
    const lastPerson = room.last?.userId ? room.people.find((person) => person.id === room.last?.userId) : null;
    const author =
      room.last?.author === "agent"
        ? (room.members.find((m) => m.id === room.last?.agentId)?.name ?? null)
        : room.last?.author === "owner" || (room.last?.author === "person" && room.last.userId === user.id)
          ? messages.live.you
          : room.last?.author === "person"
            ? (lastPerson?.name.split(" ")[0] ?? null)
            : null;
    return {
      key: room.id,
      href: `/rooms/${room.id}`,
      title: room.name,
      people: [...room.people.filter((person) => person.id !== user.id).map((person) => person.name.split(" ")[0]), ...room.members.map((member) => member.name)].join(", "),
      faces: room.members,
      author,
      line: room.last?.text ?? t.noMessages,
      at: room.last?.createdAt ?? room.createdAt,
      tag: room.teamId ? (room.teamName ?? "") : t.justMe,
      teamTag: Boolean(room.teamId),
      stopped: false,
      teamId: room.teamId,
      mine: !room.teamId,
    };
  });
  const between: Item[] = pairs.flatMap((pair) => {
    const faces = pair.ids.map((id) => byId.get(id)).filter((agent): agent is NonNullable<typeof agent> => Boolean(agent));
    if (faces.length !== 2) return [];
    const control = pair.last.kind === "stop" || pair.last.kind === "resume";
    const shared = faces.find((face) => face.teamId && teamName.has(face.teamId))?.teamId ?? null;
    return [
      {
        key: pair.ids.join("|"),
        href: `/rooms/pair/${pair.ids[0]}/${pair.ids[1]}`,
        title: t.pairName(faces[0].name, faces[1].name),
        people: "",
        faces,
        author: control ? null : (byId.get(pair.last.fromAgentId)?.name ?? null),
        line: pairLine(pair.last.kind, pair.last.text, pair.last.task),
        at: pair.last.createdAt,
        tag: shared ? (teamName.get(shared) ?? "") : t.justMe,
        teamTag: Boolean(shared),
        stopped: pair.stopped,
        teamId: shared,
        mine: faces.some((face) => face.ownerId === user.id),
      },
    ];
  });

  const filter = query.team ?? "";
  const shown = (tab === "between" ? between : groups)
    .filter((item) => (filter === "mine" ? item.mine : filter ? item.teamId === filter : true))
    .sort((a, b) => b.at.getTime() - a.at.getTime());

  const own = agents.filter((agent) => !agent.teamId);
  const ownIds = new Set(own.map((agent) => agent.id));
  const scopes: RoomScope[] = [
    ...(own.length >= ROOM_LIMITS.minParticipants ? [{ id: "", label: t.justMe, agents: own.map((agent) => ({ id: agent.id, name: agent.name, role: agent.role ?? "", look: agent.look })), people: [] }] : []),
    ...teams.map((team) => ({
      id: team.id,
      label: team.name,
      agents: teamAgents.filter((agent) => agent.teamId === team.id).map((agent) => ({ id: agent.id, name: agent.name, role: agent.role ?? "", look: agent.look })),
      people: teamPeople.filter((person) => person.teamId === team.id).map((person) => ({ id: person.id, name: person.name })),
    })),
  ];
  const presetScope = query.team && query.team !== "mine" && teamName.has(query.team) ? query.team : "";
  const preset = (query.with ?? "").split(",").filter((id) => ownIds.has(id));
  const filters = [{ id: "", label: t.all }, ...teams.map((team) => ({ id: team.id, label: team.name })), { id: "mine", label: t.justMe }];

  return (
    <div className="page narrow">
      <AutoRefresh seconds={15} />
      <div className="top">
        <div>
          <h1>{t.title}</h1>
          <p>{tab === "between" ? t.betweenSubtitle : t.subtitle}</p>
        </div>
      </div>
      <div className="flex flex-col gap-4 py-5">
        <div className="flex items-center gap-3 flex-wrap">
          <nav className="seg" aria-label={t.title}>
            <Link href={hrefWith({ team: filter })} className={`seg-opt no-underline ${tab === "groups" ? "is-on" : ""}`} aria-current={tab === "groups" ? "page" : undefined}>
              {t.groupsTab}
            </Link>
            <Link href={hrefWith({ tab: "between", team: filter })} className={`seg-opt no-underline ${tab === "between" ? "is-on" : ""}`} aria-current={tab === "between" ? "page" : undefined}>
              {t.betweenTab}
            </Link>
          </nav>
          {teams.length > 0 && (
            <nav className="seg chips" aria-label={t.filterLabel}>
              {filters.map((item) => (
                <Link key={item.id || "all"} href={hrefWith({ tab: tab === "between" ? "between" : undefined, team: item.id || undefined })} className={`seg-opt no-underline ${filter === item.id ? "is-on" : ""}`} aria-current={filter === item.id ? "true" : undefined}>
                  {item.label}
                </Link>
              ))}
            </nav>
          )}
        </div>
        {tab === "groups" &&
          (scopes.length > 0 ? (
            <NewRoomForm scopes={scopes} me={user.id} startOpen={(groups.length === 0 && between.length === 0) || preset.length > 0} initialScope={presetScope} initialPicked={preset} />
          ) : (
            <div className="card p-[18px] text-smoke text-[13px]">{t.needTwo}</div>
          ))}
        {shown.length === 0 && <p className="text-smoke text-[13px] m-0">{tab === "between" ? t.betweenEmpty : t.empty}</p>}
        <ul className="m-0 p-0 list-none flex flex-col gap-3" aria-label={tab === "between" ? t.betweenTab : t.groupsTab}>
          {shown.map((item) => (
            <li key={item.key}>
              <Link href={item.href} className="card rm-card no-underline">
                <span className="rm-stack" aria-hidden>
                  {item.faces.slice(0, 4).map((face) => (
                    <span key={face.id} className="rm-stack-item">
                      <AgentFigure size={34} look={face.look} state={face.state} live={false} />
                    </span>
                  ))}
                </span>
                <span className="min-w-0 flex-1 flex flex-col gap-0.5">
                  <span className="flex items-baseline gap-2 min-w-0">
                    <span className="font-semibold text-[15px] tracking-[-0.015em] truncate text-white">{item.title}</span>
                    {item.people && <span className="text-smoke text-[12px] truncate max-[600px]:hidden">{item.people}</span>}
                  </span>
                  <span className="text-ash text-[12.5px] truncate">
                    {item.author && <b className="text-mist font-medium">{item.author}: </b>}
                    {item.line}
                  </span>
                </span>
                <span className="flex flex-col items-end gap-1 flex-none">
                  <span className="text-smoke text-[11.5px]" suppressHydrationWarning>
                    {formatWhen(item.at)}
                  </span>
                  <span className="rm-card-tags">
                    {item.stopped && <span className="pill c">{t.stoppedTag}</span>}
                    <span className={`pill ${item.teamTag ? "a" : ""} ${item.stopped ? "rm-tag-secondary" : ""}`}>{item.tag}</span>
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
        <p className="text-smoke text-[12px] m-0">{tab === "between" ? t.betweenNote : t.groupsNote}</p>
        {tab === "between" && <p className="text-smoke text-[12px] m-0">{t.talkNote(env.agentTalkCeiling)}</p>}
      </div>
    </div>
  );
}
