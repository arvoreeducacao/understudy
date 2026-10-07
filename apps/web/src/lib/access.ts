import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "./db";

export type Access = "owner" | "approver" | "viewer";

export async function agentAccess(userId: string, agentId: string): Promise<Access | null> {
  const db = getDb();
  const [agent] = await db.select({ ownerId: schema.agents.ownerId }).from(schema.agents).where(eq(schema.agents.id, agentId));
  if (!agent) return null;
  if (agent.ownerId === userId) return "owner";
  const [member] = await db
    .select({ role: schema.agentMembers.role })
    .from(schema.agentMembers)
    .where(and(eq(schema.agentMembers.agentId, agentId), eq(schema.agentMembers.userId, userId)));
  return member?.role ?? null;
}

export async function accessibleAgentIds(userId: string, roles: Access[] = ["owner", "approver", "viewer"]) {
  const db = getDb();
  const ids = new Set<string>();
  if (roles.includes("owner")) {
    for (const a of await db.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.ownerId, userId))) ids.add(a.id);
  }
  const memberRoles = roles.filter((r): r is "approver" | "viewer" => r !== "owner");
  if (memberRoles.length > 0) {
    const rows = await db
      .select({ id: schema.agentMembers.agentId })
      .from(schema.agentMembers)
      .where(and(eq(schema.agentMembers.userId, userId), inArray(schema.agentMembers.role, memberRoles)));
    for (const r of rows) ids.add(r.id);
  }
  return [...ids];
}

export function canApprove(access: Access | null) {
  return access === "owner" || access === "approver";
}
