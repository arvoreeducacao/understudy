import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import type { ApprovalGrant } from "@/lib/db/schema";
import { ceilingForAgent } from "@/lib/slack-profile";
import { canAlwaysAllow, cleanToolNames, grantedPolicy } from "@/lib/tool-policy";
import { serverAllowedFor } from "./approval-payload";
import { ceilingOf, loadToolLimits } from "./upstream";

export async function grantTool(agentId: string, grant: ApprovalGrant, userId: string) {
  return getDb().transaction(async (tx) => {
    const [row] = await tx
      .select({ agent: schema.agents, ownerEmail: schema.user.email })
      .from(schema.agents)
      .innerJoin(schema.user, eq(schema.user.id, schema.agents.ownerId))
      .where(eq(schema.agents.id, agentId))
      .for("update", { of: schema.agents });
    if (!row || row.agent.ownerId !== userId) return false;
    if (!(row.agent.tools.servers ?? []).includes(grant.serverId)) return false;
    const [server] = await tx.select().from(schema.mcpServers).where(eq(schema.mcpServers.id, grant.serverId));
    if (!server || !serverAllowedFor(server.allowedEmails, row.ownerEmail)) return false;
    const limits = await loadToolLimits([server.id]);
    if (!canAlwaysAllow(ceilingForAgent(ceilingOf(server, limits.get(server.id)), server.url, row.agent.tools), grant.tool)) return false;
    const tools = { ...row.agent.tools, toolPolicy: grantedPolicy(row.agent.tools.toolPolicy, grant.serverId, grant.tool) };
    await tx.update(schema.agents).set({ tools, updatedAt: new Date() }).where(eq(schema.agents.id, agentId));
    return true;
  });
}

export async function setToolLimits(serverId: string, input: { ask: unknown; never: unknown }, adminId: string) {
  const never = cleanToolNames(input.never);
  const ask = cleanToolNames(input.ask).filter((tool) => !never.includes(tool));
  await getDb().transaction(async (tx) => {
    await tx.delete(schema.mcpToolLimits).where(eq(schema.mcpToolLimits.serverId, serverId));
    const rows = [...ask.map((tool) => ({ tool, level: "ask" as const })), ...never.map((tool) => ({ tool, level: "never" as const }))];
    if (rows.length) await tx.insert(schema.mcpToolLimits).values(rows.map((row) => ({ ...row, serverId, updatedBy: adminId, updatedAt: new Date() })));
    await tx.update(schema.mcpServers).set({ askTools: [] }).where(eq(schema.mcpServers.id, serverId));
  });
  return { ask, never };
}

export async function toolLimitsOf(serverId: string) {
  const rows = await getDb().select().from(schema.mcpToolLimits).where(eq(schema.mcpToolLimits.serverId, serverId));
  return { ask: rows.filter((row) => row.level === "ask").map((row) => row.tool), never: rows.filter((row) => row.level === "never").map((row) => row.tool) };
}
