import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { getDb, schema } from "./db";
import { teamAccess, type Access } from "./access-rules";
import { isAdmin } from "./env";

export { canAnswer, canApprove, canChat, canManage, teamAccess, type Access } from "./access-rules";

async function readsEveryAgent(userId: string) {
  const [row] = await getDb()
    .select({ email: schema.user.email, admin: schema.user.admin, source: schema.user.source, status: schema.user.status })
    .from(schema.user)
    .where(eq(schema.user.id, userId));
  return Boolean(row && row.status === "approved" && isAdmin(row.email, row.admin, row.source));
}

export async function agentAccess(userId: string, agentId: string): Promise<Access | null> {
  const db = getDb();
  const [agent] = await db
    .select({ ownerId: schema.agents.ownerId, teamId: schema.agents.teamId, teamOwned: schema.agents.teamOwned })
    .from(schema.agents)
    .where(eq(schema.agents.id, agentId));
  if (!agent) return null;
  if (agent.ownerId === userId) return "owner";
  if (agent.teamId) {
    const [seat] = await db
      .select({ role: schema.teamMembers.role })
      .from(schema.teamMembers)
      .where(and(eq(schema.teamMembers.teamId, agent.teamId), eq(schema.teamMembers.userId, userId)));
    const access = teamAccess(seat?.role, agent.teamOwned);
    if (access) return access;
  }
  const [member] = await db
    .select({ role: schema.agentMembers.role })
    .from(schema.agentMembers)
    .where(and(eq(schema.agentMembers.agentId, agentId), eq(schema.agentMembers.userId, userId)));
  if (member) return member.role;
  return (await readsEveryAgent(userId)) ? "viewer" : null;
}

export async function accessibleAgentIds(userId: string, roles: Access[] = ["owner", "admin", "member", "approver", "viewer"]) {
  const db = getDb();
  const ids = new Set<string>();
  if (roles.includes("viewer") && (await readsEveryAgent(userId))) {
    for (const a of await db.select({ id: schema.agents.id }).from(schema.agents)) ids.add(a.id);
    return [...ids];
  }
  if (roles.includes("owner")) {
    for (const a of await db.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.ownerId, userId))) ids.add(a.id);
  }
  if (roles.includes("admin") || roles.includes("member")) {
    const rows = await db
      .select({ id: schema.agents.id, ownerId: schema.agents.ownerId, teamOwned: schema.agents.teamOwned, role: schema.teamMembers.role })
      .from(schema.teamMembers)
      .innerJoin(schema.agents, eq(schema.agents.teamId, schema.teamMembers.teamId))
      .where(eq(schema.teamMembers.userId, userId));
    for (const r of rows) {
      const access = r.ownerId === userId ? "owner" : teamAccess(r.role, r.teamOwned);
      if (access && roles.includes(access)) ids.add(r.id);
    }
  }
  const memberRoles = roles.filter((r): r is "approver" | "viewer" => r === "approver" || r === "viewer");
  if (memberRoles.length > 0) {
    const rows = await db
      .select({ id: schema.agentMembers.agentId })
      .from(schema.agentMembers)
      .where(and(eq(schema.agentMembers.userId, userId), inArray(schema.agentMembers.role, memberRoles)));
    for (const r of rows) ids.add(r.id);
  }
  return [...ids];
}

export async function approvalScope(userId: string) {
  const ids = await accessibleAgentIds(userId, ["owner", "admin", "approver"]);
  const mine = eq(schema.approvals.askedBy, userId);
  return ids.length ? or(and(inArray(schema.approvals.agentId, ids), isNull(schema.approvals.askedBy)), mine)! : mine;
}
