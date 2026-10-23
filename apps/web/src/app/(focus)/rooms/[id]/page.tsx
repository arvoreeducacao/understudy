import { and, eq, inArray, notInArray } from "drizzle-orm";
import { notFound } from "next/navigation";
import { RoomInside } from "@/components/rooms/RoomInside";
import { getDb, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { localeOr } from "@/lib/messages";
import { requireUser } from "@/lib/session";
import { getHub } from "@/server/hub-access";
import { roomFor, roomMembers, roomPeopleOf, toRoomEntry } from "@/server/hub/rooms";
import { loadRoomMessages } from "@/server/room-store";

export default async function RoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const room = await roomFor(id, user.id);
  if (!room) notFound();
  const db = getDb();
  const [members, history, people, [team]] = await Promise.all([
    roomMembers(id),
    loadRoomMessages(id),
    room.teamId ? roomPeopleOf(id) : Promise.resolve([]),
    room.teamId ? db.select({ id: schema.teams.id, name: schema.teams.name, language: schema.teams.language }).from(schema.teams).where(eq(schema.teams.id, room.teamId)) : Promise.resolve([]),
  ]);
  const memberIds = members.map((member) => member.id);
  const approvalIds = history.map((row) => row.approvalId).filter((value): value is string => Boolean(value));
  const [agents, approvals, addableAgents, addablePeople] = await Promise.all([
    memberIds.length
      ? db.select({ id: schema.agents.id, look: schema.agents.look, state: schema.agents.state }).from(schema.agents).where(inArray(schema.agents.id, memberIds))
      : [],
    approvalIds.length ? db.select({ id: schema.approvals.id, status: schema.approvals.status }).from(schema.approvals).where(inArray(schema.approvals.id, approvalIds)) : [],
    room.teamId
      ? db
          .select({ id: schema.agents.id, name: schema.agents.name })
          .from(schema.agents)
          .where(memberIds.length ? and(eq(schema.agents.teamId, room.teamId), notInArray(schema.agents.id, memberIds)) : eq(schema.agents.teamId, room.teamId))
      : [],
    room.teamId
      ? db
          .select({ id: schema.user.id, name: schema.user.name })
          .from(schema.teamMembers)
          .innerJoin(schema.user, eq(schema.user.id, schema.teamMembers.userId))
          .where(people.length ? and(eq(schema.teamMembers.teamId, room.teamId), notInArray(schema.teamMembers.userId, people.map((person) => person.id))) : eq(schema.teamMembers.teamId, room.teamId))
      : [],
  ]);
  const [seat] = room.teamId && room.ownerId !== user.id
    ? await db.select({ role: schema.teamMembers.role }).from(schema.teamMembers).where(and(eq(schema.teamMembers.teamId, room.teamId), eq(schema.teamMembers.userId, user.id)))
    : [];
  const hub = getHub();
  return (
    <RoomInside
      room={{ id: room.id, name: room.name }}
      me={user.id}
      team={team ? { id: team.id, name: team.name, language: localeOr(team.language) } : null}
      people={people}
      addable={{ agents: addableAgents, people: addablePeople }}
      canDelete={room.ownerId === user.id || seat?.role === "admin"}
      approvals={Object.fromEntries(approvals.map((approval) => [approval.id, approval.status]))}
      members={members.map((member) => {
        const agent = agents.find((a) => a.id === member.id);
        return { id: member.id, name: member.name, role: member.role ?? "", look: agent?.look ?? ({} as never), state: agent?.state ?? "calm", online: hub?.isOnline(member.id) ?? false };
      })}
      initial={history.map(toRoomEntry)}
      ceiling={env.agentTalkCeiling}
    />
  );
}
