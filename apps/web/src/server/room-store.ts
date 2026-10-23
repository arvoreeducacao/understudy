import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/ids";
import { messages } from "@/lib/messages";
import { cleanRoomName, ROOM_LIMITS } from "@/lib/rooms";

export type CreateRoomResult = { ok: true; id: string } | { ok: false; error: string };

export async function createRoom(ownerId: string, input: { name: unknown; agentIds: unknown[] }): Promise<CreateRoomResult> {
  const name = cleanRoomName(input.name);
  if (!name) return { ok: false, error: messages.rooms.nameRequired };
  const wanted = [...new Set(input.agentIds.map(String).filter(Boolean))].slice(0, ROOM_LIMITS.maxParticipants + 1);
  if (wanted.length < ROOM_LIMITS.minParticipants) return { ok: false, error: messages.rooms.pickMore(ROOM_LIMITS.minParticipants) };
  if (wanted.length > ROOM_LIMITS.maxParticipants) return { ok: false, error: messages.rooms.whoHint(ROOM_LIMITS.minParticipants, ROOM_LIMITS.maxParticipants) };
  const db = getDb();
  const own = await db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(and(inArray(schema.agents.id, wanted), eq(schema.agents.ownerId, ownerId)));
  if (own.length !== wanted.length) return { ok: false, error: messages.rooms.notYours };
  const id = newId("room");
  await db.transaction(async (tx) => {
    await tx.insert(schema.rooms).values({ id, ownerId, name });
    await tx.insert(schema.roomParticipants).values(wanted.map((agentId) => ({ roomId: id, agentId })));
  });
  console.log(JSON.stringify({ event: "room_created", roomId: id, ownerId, participants: wanted.length }));
  return { ok: true, id };
}

export async function createTeamRoom(userId: string, input: { teamId: unknown; name: unknown; agentIds: unknown[]; peopleIds: unknown[] }): Promise<CreateRoomResult> {
  const teamId = String(input.teamId ?? "");
  const name = cleanRoomName(input.name);
  if (!name) return { ok: false, error: messages.rooms.nameRequired };
  const db = getDb();
  const members = await db.select({ userId: schema.teamMembers.userId }).from(schema.teamMembers).where(eq(schema.teamMembers.teamId, teamId));
  const inTeam = new Set(members.map((member) => member.userId));
  if (!inTeam.has(userId)) return { ok: false, error: messages.teams.notInTeam };
  const wanted = [...new Set(input.agentIds.map(String).filter(Boolean))].slice(0, ROOM_LIMITS.maxParticipants + 1);
  if (wanted.length < ROOM_LIMITS.minTeamParticipants) return { ok: false, error: messages.rooms.pickMore(ROOM_LIMITS.minTeamParticipants) };
  if (wanted.length > ROOM_LIMITS.maxParticipants) return { ok: false, error: messages.rooms.whoHint(ROOM_LIMITS.minTeamParticipants, ROOM_LIMITS.maxParticipants) };
  const teamAgents = await db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(and(inArray(schema.agents.id, wanted), eq(schema.agents.teamId, teamId)));
  if (teamAgents.length !== wanted.length) return { ok: false, error: messages.rooms.notTeams };
  const people = [...new Set([userId, ...input.peopleIds.map(String)])].filter((id) => inTeam.has(id)).slice(0, ROOM_LIMITS.maxPeople);
  const id = newId("room");
  await db.transaction(async (tx) => {
    await tx.insert(schema.rooms).values({ id, ownerId: userId, teamId, name });
    await tx.insert(schema.roomParticipants).values(wanted.map((agentId) => ({ roomId: id, agentId })));
    await tx.insert(schema.roomPeople).values(people.map((personId) => ({ roomId: id, userId: personId })));
  });
  console.log(JSON.stringify({ event: "room_created", roomId: id, ownerId: userId, teamId, participants: wanted.length, people: people.length }));
  return { ok: true, id };
}

export async function deleteOwnedRoom(userId: string, roomId: string) {
  const db = getDb();
  const [room] = await db.select({ ownerId: schema.rooms.ownerId, teamId: schema.rooms.teamId }).from(schema.rooms).where(eq(schema.rooms.id, roomId));
  if (!room) return false;
  if (room.ownerId !== userId) {
    if (!room.teamId) return false;
    const [seat] = await db
      .select({ role: schema.teamMembers.role })
      .from(schema.teamMembers)
      .where(and(eq(schema.teamMembers.teamId, room.teamId), eq(schema.teamMembers.userId, userId)));
    if (seat?.role !== "admin") return false;
  }
  const deleted = await db.delete(schema.rooms).where(eq(schema.rooms.id, roomId)).returning({ id: schema.rooms.id });
  return deleted.length > 0;
}

export async function roomIdsFor(userId: string) {
  const db = getDb();
  const [own, joined] = await Promise.all([
    db.select({ id: schema.rooms.id }).from(schema.rooms).where(and(eq(schema.rooms.ownerId, userId), isNull(schema.rooms.teamId))),
    db
      .select({ id: schema.rooms.id })
      .from(schema.roomPeople)
      .innerJoin(schema.rooms, eq(schema.rooms.id, schema.roomPeople.roomId))
      .innerJoin(schema.teamMembers, and(eq(schema.teamMembers.teamId, schema.rooms.teamId), eq(schema.teamMembers.userId, userId)))
      .where(eq(schema.roomPeople.userId, userId)),
  ]);
  return [...new Set([...own, ...joined].map((row) => row.id))];
}

export async function listRooms(userId: string) {
  const db = getDb();
  const visible = await roomIdsFor(userId);
  if (!visible.length) return [];
  const rooms = await db
    .select({ id: schema.rooms.id, ownerId: schema.rooms.ownerId, teamId: schema.rooms.teamId, name: schema.rooms.name, createdAt: schema.rooms.createdAt, updatedAt: schema.rooms.updatedAt, teamName: schema.teams.name })
    .from(schema.rooms)
    .leftJoin(schema.teams, eq(schema.teams.id, schema.rooms.teamId))
    .where(inArray(schema.rooms.id, visible))
    .orderBy(desc(schema.rooms.updatedAt));
  const ids = rooms.map((room) => room.id);
  const members = await db
    .select({ roomId: schema.roomParticipants.roomId, id: schema.agents.id, name: schema.agents.name, look: schema.agents.look, state: schema.agents.state })
    .from(schema.roomParticipants)
    .innerJoin(schema.agents, eq(schema.agents.id, schema.roomParticipants.agentId))
    .where(inArray(schema.roomParticipants.roomId, ids));
  const latest = await db
    .selectDistinctOn([schema.roomMessages.roomId], { roomId: schema.roomMessages.roomId, text: schema.roomMessages.text, author: schema.roomMessages.author, agentId: schema.roomMessages.agentId, userId: schema.roomMessages.userId, createdAt: schema.roomMessages.createdAt })
    .from(schema.roomMessages)
    .where(inArray(schema.roomMessages.roomId, ids))
    .orderBy(schema.roomMessages.roomId, desc(schema.roomMessages.createdAt));
  const people = await db
    .select({ roomId: schema.roomPeople.roomId, id: schema.user.id, name: schema.user.name })
    .from(schema.roomPeople)
    .innerJoin(schema.user, eq(schema.user.id, schema.roomPeople.userId))
    .where(inArray(schema.roomPeople.roomId, ids));
  return rooms.map((room) => ({
    ...room,
    members: members.filter((member) => member.roomId === room.id),
    people: people.filter((person) => person.roomId === room.id),
    last: latest.find((row) => row.roomId === room.id) ?? null,
  }));
}

export async function sharedTeamRoom(agentA: string, agentB: string) {
  const db = getDb();
  const seats = await db
    .select({ roomId: schema.roomParticipants.roomId, agentId: schema.roomParticipants.agentId })
    .from(schema.roomParticipants)
    .where(inArray(schema.roomParticipants.agentId, [agentA, agentB]));
  const ofA = new Set(seats.filter((seat) => seat.agentId === agentA).map((seat) => seat.roomId));
  const both = [...new Set(seats.filter((seat) => seat.agentId === agentB && ofA.has(seat.roomId)).map((seat) => seat.roomId))];
  if (!both.length) return null;
  const [room] = await db
    .select({ id: schema.rooms.id })
    .from(schema.rooms)
    .where(and(inArray(schema.rooms.id, both), isNotNull(schema.rooms.teamId)))
    .orderBy(desc(schema.rooms.updatedAt), desc(schema.rooms.createdAt))
    .limit(1);
  return room?.id ?? null;
}

export async function loadRoomMessages(roomId: string, limit = 200) {
  const rows = await getDb().select().from(schema.roomMessages).where(eq(schema.roomMessages.roomId, roomId)).orderBy(desc(schema.roomMessages.createdAt)).limit(limit);
  return rows.reverse();
}

export async function addToTeamRoom(userId: string, roomId: string, input: { agentIds: unknown[]; peopleIds: unknown[] }): Promise<{ ok: boolean; error?: string }> {
  const db = getDb();
  const [room] = await db.select({ teamId: schema.rooms.teamId }).from(schema.rooms).where(eq(schema.rooms.id, roomId));
  if (!room?.teamId) return { ok: false, error: messages.common.notFound };
  const [members, seated, agents, teamAgentRows] = await Promise.all([
    db.select({ userId: schema.teamMembers.userId }).from(schema.teamMembers).where(eq(schema.teamMembers.teamId, room.teamId)),
    db.select({ userId: schema.roomPeople.userId }).from(schema.roomPeople).where(eq(schema.roomPeople.roomId, roomId)),
    db.select({ agentId: schema.roomParticipants.agentId }).from(schema.roomParticipants).where(eq(schema.roomParticipants.roomId, roomId)),
    db.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.teamId, room.teamId)),
  ]);
  const inTeam = new Set(members.map((row) => row.userId));
  if (!inTeam.has(userId) || !seated.some((row) => row.userId === userId)) return { ok: false, error: messages.common.notFound };
  const teamAgents = new Set(teamAgentRows.map((row) => row.id));
  const newAgents = [...new Set(input.agentIds.map(String))].filter((id) => teamAgents.has(id) && !agents.some((row) => row.agentId === id));
  const newPeople = [...new Set(input.peopleIds.map(String))].filter((id) => inTeam.has(id) && !seated.some((row) => row.userId === id));
  if (agents.length + newAgents.length > ROOM_LIMITS.maxParticipants) return { ok: false, error: messages.rooms.whoHint(ROOM_LIMITS.minTeamParticipants, ROOM_LIMITS.maxParticipants) };
  if (seated.length + newPeople.length > ROOM_LIMITS.maxPeople) return { ok: false, error: messages.rooms.tooManyPeople(ROOM_LIMITS.maxPeople) };
  if (newAgents.length) await db.insert(schema.roomParticipants).values(newAgents.map((agentId) => ({ roomId, agentId })));
  if (newPeople.length) await db.insert(schema.roomPeople).values(newPeople.map((personId) => ({ roomId, userId: personId })));
  return { ok: true };
}
