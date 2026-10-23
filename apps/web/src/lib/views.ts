import { and, asc, desc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { getDb, schema } from "./db";
import type { ApprovalView, ChatEntry, ProposalView } from "@/server/hub-types";

export async function loadChat(agentId: string, limit = 150, viewerId?: string, manages = false): Promise<ChatEntry[]> {
  const own = viewerId ? or(isNull(schema.messages.audienceId), eq(schema.messages.audienceId, viewerId)) : isNull(schema.messages.audienceId);
  const visible = manages ? or(own, isNotNull(schema.messages.proposalId)) : own;
  const rows = await getDb()
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.agentId, agentId), visible))
    .orderBy(desc(schema.messages.createdAt))
    .limit(limit);
  const proposalIds = rows.map((m) => m.proposalId).filter((id): id is string => Boolean(id));
  const proposals = proposalIds.length ? await getDb().select().from(schema.taskProposals).where(inArray(schema.taskProposals.id, proposalIds)) : [];
  const byId = new Map(proposals.map((row) => [row.id, toProposalView(row)]));
  return rows
    .reverse()
    .filter((m) => !m.proposalId || byId.has(m.proposalId))
    .map((m) => {
      const proposal = m.proposalId ? byId.get(m.proposalId) : undefined;
      return { id: m.id, role: m.role, text: m.text, runId: m.runId, via: m.via, ...(m.sender ? { sender: m.sender } : {}), at: m.createdAt.toISOString(), ...(m.attachments?.length ? { attachments: m.attachments } : {}), ...(m.artifact ? { artifact: m.artifact } : {}), ...(proposal ? { proposal } : {}) };
    });
}

export async function loadPendingApprovals(agentId: string, viewerId?: string): Promise<ApprovalView[]> {
  const visible = viewerId ? or(isNull(schema.approvals.askedBy), eq(schema.approvals.askedBy, viewerId)) : isNull(schema.approvals.askedBy);
  const rows = await getDb()
    .select()
    .from(schema.approvals)
    .where(and(eq(schema.approvals.agentId, agentId), eq(schema.approvals.status, "pending"), visible))
    .orderBy(asc(schema.approvals.createdAt));
  return rows.map(toApprovalView);
}

export function toApprovalView(a: typeof schema.approvals.$inferSelect): ApprovalView {
  return {
    id: a.id,
    agentId: a.agentId,
    runId: a.runId,
    stepId: a.stepId,
    summary: a.summary,
    fields: a.fields,
    status: a.status,
    createdAt: a.createdAt.toISOString(),
    ...(a.grant ? { alwaysAllow: { tool: a.grant.tool } } : {}),
    ...(a.askedBy ? { forYou: true as const } : {}),
  };
}

export async function loadRuns(agentId: string, limit = 8) {
  return getDb()
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.agentId, agentId))
    .orderBy(desc(schema.runs.startedAt))
    .limit(limit);
}

export function toProposalView(row: typeof schema.taskProposals.$inferSelect): ProposalView {
  return {
    id: row.id,
    agentId: row.agentId,
    recipe: row.recipe,
    cron: row.cron,
    timezone: row.timezone,
    reason: row.reason,
    origin: row.origin,
    status: row.status,
    recipeId: row.recipeId,
    createdAt: row.createdAt.toISOString(),
  };
}
