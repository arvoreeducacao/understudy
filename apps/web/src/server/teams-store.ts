import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { runsOnOwnKey } from "@/lib/brain-account";
import { getDb, schema } from "@/lib/db";
import type { AgentTools, TeamRole } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { LOCALES, messages } from "@/lib/messages";
import { teamConnector } from "./approval-payload";

export const TEAM_LIMITS = { nameMax: 60, descriptionMax: 200, membersMax: 200 } as const;

export type TeamResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

function cleanName(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, TEAM_LIMITS.nameMax);
}

function cleanDescription(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, TEAM_LIMITS.descriptionMax);
}

function cleanRole(value: unknown): TeamRole {
  return value === "admin" ? "admin" : "member";
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

function leaveTeamRooms(tx: Tx, teamId: string, who: { userId?: string; agentIds?: string[] }) {
  const rooms = tx.select({ id: schema.rooms.id }).from(schema.rooms).where(eq(schema.rooms.teamId, teamId));
  if (who.userId) return tx.delete(schema.roomPeople).where(and(eq(schema.roomPeople.userId, who.userId), inArray(schema.roomPeople.roomId, rooms)));
  if (who.agentIds?.length) return tx.delete(schema.roomParticipants).where(and(inArray(schema.roomParticipants.agentId, who.agentIds), inArray(schema.roomParticipants.roomId, rooms)));
  return Promise.resolve();
}

export async function ownerAudience(agentId: string) {
  const [agent] = await getDb().select({ ownerId: schema.agents.ownerId, teamId: schema.agents.teamId }).from(schema.agents).where(eq(schema.agents.id, agentId));
  return agent?.teamId ? agent.ownerId : null;
}

export async function teamRole(teamId: string, userId: string): Promise<TeamRole | null> {
  const [row] = await getDb()
    .select({ role: schema.teamMembers.role })
    .from(schema.teamMembers)
    .where(and(eq(schema.teamMembers.teamId, teamId), eq(schema.teamMembers.userId, userId)));
  return row?.role ?? null;
}

export async function createTeam(userId: string, input: { name: unknown; description?: unknown }): Promise<TeamResult<{ id: string }>> {
  const name = cleanName(input.name);
  if (!name) return { ok: false, error: messages.teams.nameRequired };
  const id = newId("team");
  await getDb().transaction(async (tx) => {
    await tx.insert(schema.teams).values({ id, name, description: cleanDescription(input.description), createdBy: userId });
    await tx.insert(schema.teamMembers).values({ teamId: id, userId, role: "admin" });
  });
  console.log(JSON.stringify({ event: "team_created", teamId: id, userId }));
  return { ok: true, id };
}

export async function updateTeam(teamId: string, actorId: string, input: { name: unknown; description?: unknown; language?: unknown }): Promise<TeamResult> {
  if ((await teamRole(teamId, actorId)) !== "admin") return { ok: false, error: messages.teams.adminsOnly };
  const name = cleanName(input.name);
  if (!name) return { ok: false, error: messages.teams.nameRequired };
  await getDb()
    .update(schema.teams)
    .set({ name, description: cleanDescription(input.description), ...(input.language === undefined ? {} : { language: LOCALES.includes(String(input.language)) ? String(input.language) : null }), updatedAt: new Date() })
    .where(eq(schema.teams.id, teamId));
  return { ok: true };
}

export async function deleteTeam(teamId: string, actorId: string): Promise<TeamResult> {
  if ((await teamRole(teamId, actorId)) !== "admin") return { ok: false, error: messages.teams.adminsOnly };
  await getDb().transaction(async (tx) => {
    await tx.update(schema.agents).set({ teamId: null, teamOwned: false, updatedAt: new Date() }).where(eq(schema.agents.teamId, teamId));
    await tx.delete(schema.teams).where(eq(schema.teams.id, teamId));
  });
  console.log(JSON.stringify({ event: "team_deleted", teamId, actorId }));
  return { ok: true };
}

export async function teamsFor(userId: string) {
  const db = getDb();
  const rows = await db
    .select({ id: schema.teams.id, name: schema.teams.name, description: schema.teams.description, role: schema.teamMembers.role })
    .from(schema.teamMembers)
    .innerJoin(schema.teams, eq(schema.teams.id, schema.teamMembers.teamId))
    .where(eq(schema.teamMembers.userId, userId))
    .orderBy(asc(schema.teams.name));
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const [people, agents] = await Promise.all([
    db
      .select({ teamId: schema.teamMembers.teamId, count: sql<number>`count(*)::int` })
      .from(schema.teamMembers)
      .where(inArray(schema.teamMembers.teamId, ids))
      .groupBy(schema.teamMembers.teamId),
    db
      .select({ teamId: schema.agents.teamId, id: schema.agents.id, name: schema.agents.name, look: schema.agents.look, state: schema.agents.state, note: schema.agents.stateNote })
      .from(schema.agents)
      .where(inArray(schema.agents.teamId, ids))
      .orderBy(asc(schema.agents.name)),
  ]);
  return rows.map((row) => ({
    ...row,
    people: people.find((p) => p.teamId === row.id)?.count ?? 0,
    agents: agents.filter((agent) => agent.teamId === row.id).map(({ teamId: _, ...agent }) => agent),
  }));
}

export async function loadTeam(teamId: string, userId: string) {
  const db = getDb();
  const role = await teamRole(teamId, userId);
  if (!role) return null;
  const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
  if (!team) return null;
  const [people, agents] = await Promise.all([
    db
      .select({ userId: schema.user.id, name: schema.user.name, email: schema.user.email, role: schema.teamMembers.role })
      .from(schema.teamMembers)
      .innerJoin(schema.user, eq(schema.user.id, schema.teamMembers.userId))
      .where(eq(schema.teamMembers.teamId, teamId))
      .orderBy(asc(schema.user.name)),
    db
      .select({
        id: schema.agents.id,
        name: schema.agents.name,
        role: schema.agents.role,
        look: schema.agents.look,
        state: schema.agents.state,
        note: schema.agents.stateNote,
        teamOwned: schema.agents.teamOwned,
        ownerId: schema.agents.ownerId,
        ownerName: schema.user.name,
        tools: schema.agents.tools,
        brain: schema.agents.brain,
        brainAccount: schema.agents.brainAccount,
      })
      .from(schema.agents)
      .innerJoin(schema.user, eq(schema.user.id, schema.agents.ownerId))
      .where(eq(schema.agents.teamId, teamId))
      .orderBy(asc(schema.agents.name)),
  ]);
  const serverIds = [...new Set(agents.flatMap((agent) => agent.tools.servers ?? []))];
  const connectors = serverIds.length
    ? await db.select({ id: schema.mcpServers.id, name: schema.mcpServers.name, allowedEmails: schema.mcpServers.allowedEmails, oauthClient: schema.mcpServers.oauthClient }).from(schema.mcpServers).where(inArray(schema.mcpServers.id, serverIds))
    : [];
  return {
    team,
    role,
    people,
    agents: agents.map(({ tools: _, brain, brainAccount, ...agent }) => ({ ...agent, ownKey: runsOnOwnKey(brain, brainAccount) })),
    connectors: connectors
      .filter(teamConnector)
      .map((connector) => ({ id: connector.id, name: connector.name, agents: agents.filter((agent) => agent.tools.servers?.includes(connector.id)).map((agent) => agent.name) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export async function addMember(teamId: string, actorId: string, email: unknown, role: unknown): Promise<TeamResult> {
  if ((await teamRole(teamId, actorId)) !== "admin") return { ok: false, error: messages.teams.adminsOnly };
  const wanted = String(email ?? "").trim().toLowerCase();
  if (!wanted) return { ok: false, error: messages.teams.emailRequired };
  const db = getDb();
  const [person] = await db
    .select({ id: schema.user.id, status: schema.user.status })
    .from(schema.user)
    .where(sql`lower(${schema.user.email}) = ${wanted}`);
  if (!person || person.status !== "approved") return { ok: false, error: messages.teams.noSuchPerson };
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(schema.teamMembers).where(eq(schema.teamMembers.teamId, teamId));
  if (count >= TEAM_LIMITS.membersMax) return { ok: false, error: messages.teams.full(TEAM_LIMITS.membersMax) };
  await db
    .insert(schema.teamMembers)
    .values({ teamId, userId: person.id, role: cleanRole(role) })
    .onConflictDoUpdate({ target: [schema.teamMembers.teamId, schema.teamMembers.userId], set: { role: cleanRole(role) } });
  console.log(JSON.stringify({ event: "team_member_added", teamId, actorId, userId: person.id }));
  return { ok: true };
}

async function otherAdmins(teamId: string, userId: string) {
  const rows = await getDb()
    .select({ userId: schema.teamMembers.userId })
    .from(schema.teamMembers)
    .where(and(eq(schema.teamMembers.teamId, teamId), eq(schema.teamMembers.role, "admin")));
  return rows.filter((row) => row.userId !== userId).length;
}

export async function setMemberRole(teamId: string, actorId: string, userId: string, role: unknown): Promise<TeamResult> {
  if ((await teamRole(teamId, actorId)) !== "admin") return { ok: false, error: messages.teams.adminsOnly };
  const next = cleanRole(role);
  if (next === "member" && (await otherAdmins(teamId, userId)) === 0) return { ok: false, error: messages.teams.lastAdmin };
  const updated = await getDb()
    .update(schema.teamMembers)
    .set({ role: next })
    .where(and(eq(schema.teamMembers.teamId, teamId), eq(schema.teamMembers.userId, userId)))
    .returning({ userId: schema.teamMembers.userId });
  return updated.length ? { ok: true } : { ok: false, error: messages.common.notFound };
}

export async function removeMember(teamId: string, actorId: string, userId: string): Promise<TeamResult> {
  const actor = await teamRole(teamId, actorId);
  if (actor !== "admin" && actorId !== userId) return { ok: false, error: messages.teams.adminsOnly };
  const leaving = await teamRole(teamId, userId);
  if (!leaving) return { ok: false, error: messages.common.notFound };
  if (leaving === "admin" && (await otherAdmins(teamId, userId)) === 0) return { ok: false, error: messages.teams.lastAdmin };
  await getDb().transaction(async (tx) => {
    const lent = await tx
      .update(schema.agents)
      .set({ teamId: null, updatedAt: new Date() })
      .where(and(eq(schema.agents.teamId, teamId), eq(schema.agents.ownerId, userId), eq(schema.agents.teamOwned, false)))
      .returning({ id: schema.agents.id });
    await leaveTeamRooms(tx, teamId, { agentIds: lent.map((agent) => agent.id) });
    await leaveTeamRooms(tx, teamId, { userId });
    await tx.delete(schema.teamMembers).where(and(eq(schema.teamMembers.teamId, teamId), eq(schema.teamMembers.userId, userId)));
  });
  console.log(JSON.stringify({ event: "team_member_removed", teamId, actorId, userId }));
  return { ok: true };
}

export async function personalConnectors(tools: AgentTools) {
  const ids = tools.servers ?? [];
  if (!ids.length) return [];
  const rows = await getDb()
    .select({ id: schema.mcpServers.id, name: schema.mcpServers.name, allowedEmails: schema.mcpServers.allowedEmails, oauthClient: schema.mcpServers.oauthClient })
    .from(schema.mcpServers)
    .where(inArray(schema.mcpServers.id, ids));
  return rows.filter((row) => !teamConnector(row)).map((row) => ({ id: row.id, name: row.name }));
}

export async function bringAgent(agentId: string, actorId: string, teamId: string, owned: boolean): Promise<TeamResult<{ removed: string[] }>> {
  const db = getDb();
  const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.id, agentId));
  if (!agent || agent.ownerId !== actorId) return { ok: false, error: messages.common.notFound };
  if (!(await teamRole(teamId, actorId))) return { ok: false, error: messages.teams.notInTeam };
  const personal = await personalConnectors(agent.tools);
  const dropped = new Set(personal.map((connector) => connector.id));
  const tools: AgentTools = { ...agent.tools, servers: (agent.tools.servers ?? []).filter((id) => !dropped.has(id)) };
  await db.transaction(async (tx) => {
    if (agent.teamId && agent.teamId !== teamId) await leaveTeamRooms(tx, agent.teamId, { agentIds: [agentId] });
    await tx.update(schema.agents).set({ teamId, teamOwned: owned, tools, updatedAt: new Date() }).where(eq(schema.agents.id, agentId));
  });
  console.log(JSON.stringify({ event: "team_agent_added", teamId, agentId, actorId, owned, removedConnectors: personal.length }));
  return { ok: true, removed: personal.map((connector) => connector.name) };
}

export async function releaseAgent(agentId: string, actorId: string): Promise<TeamResult> {
  const db = getDb();
  const [agent] = await db.select({ ownerId: schema.agents.ownerId, teamId: schema.agents.teamId, teamOwned: schema.agents.teamOwned }).from(schema.agents).where(eq(schema.agents.id, agentId));
  if (!agent?.teamId) return { ok: false, error: messages.common.notFound };
  const allowed = agent.teamOwned ? (await teamRole(agent.teamId, actorId)) === "admin" : agent.ownerId === actorId;
  if (!allowed) return { ok: false, error: messages.teams.adminsOnly };
  const teamId = agent.teamId;
  await db.transaction(async (tx) => {
    await leaveTeamRooms(tx, teamId, { agentIds: [agentId] });
    await tx.update(schema.agents).set({ teamId: null, teamOwned: false, updatedAt: new Date() }).where(eq(schema.agents.id, agentId));
  });
  console.log(JSON.stringify({ event: "team_agent_released", teamId: agent.teamId, agentId, actorId }));
  return { ok: true };
}
