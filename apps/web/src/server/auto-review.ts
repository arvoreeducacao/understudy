import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { brainText } from "@/lib/brain-text";
import type { ApprovalGrant } from "@/lib/db/schema";
import { messages as copy } from "@/lib/messages";
import type { Hub } from "./hub";
import { REVIEWER_FIELD, reviewerFromEnv, stepsAside, type Reviewer, type ReviewField, type ReviewInput } from "./reviewer";

export type ReviewRequest = { summary: string; fields: ReviewField[]; runId?: string; stepId?: string };

const OWNER_MESSAGES = 3;

function log(event: string, data: Record<string, unknown>) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
}

function startOfDay(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export async function reviewContext(hub: Hub, agentId: string, runId: string | undefined): Promise<Pick<ReviewInput, "ownerRequest" | "task">> {
  const db = getDb();
  if (runId) {
    const [run] = await db
      .select({ input: schema.runs.input, recipe: schema.recipes.recipe })
      .from(schema.runs)
      .leftJoin(schema.recipes, eq(schema.recipes.id, schema.runs.recipeId))
      .where(and(eq(schema.runs.id, runId), eq(schema.runs.agentId, agentId)));
    const title = run?.recipe?.title ?? "";
    return {
      ownerRequest: run?.input?.trim() || (title ? `Run my saved task "${title}".` : ""),
      ...(run?.recipe ? { task: { title, steps: run.recipe.steps.map((step) => step.text) } } : {}),
    };
  }
  const audience = hub.turnAudience(agentId);
  const said = await db
    .select({ text: schema.messages.text })
    .from(schema.messages)
    .where(and(eq(schema.messages.agentId, agentId), eq(schema.messages.role, "user"), isNull(schema.messages.runId), audience ? eq(schema.messages.authorId, audience) : undefined, gte(schema.messages.createdAt, startOfDay(new Date()))))
    .orderBy(desc(schema.messages.createdAt))
    .limit(OWNER_MESSAGES);
  return { ownerRequest: said.reverse().map((row) => row.text).join("\n") };
}

export type ReviewOutcome = { kind: "approved"; id: string } | { kind: "ask"; fields: ReviewField[] };

export async function autoReview(
  hub: Hub,
  agentId: string,
  request: ReviewRequest,
  approval: { lifetimeSeconds: number; payloadHash?: string; grant?: ApprovalGrant },
  reviewer: Reviewer | null = reviewerFromEnv(),
): Promise<ReviewOutcome> {
  const runId = request.runId ?? null;
  const asked = { kind: "ask" as const, fields: request.fields };
  if (!reviewer || request.stepId) return asked;
  const recent = await hub.approvals.recentReviews(agentId, { runId, askedBy: runId ? null : hub.turnAudience(agentId), since: startOfDay(new Date()) });
  if (stepsAside(recent)) {
    log("reviewer_stepped_aside", { agentId, runId });
    return asked;
  }
  const context = await reviewContext(hub, agentId, request.runId);
  const verdict = await reviewer.review({ ...context, action: { summary: request.summary, fields: request.fields } });
  log("reviewer_decision", { agentId, runId, decision: verdict.decision, model: verdict.model });
  const audience = runId ? null : hub.turnAudience(agentId);
  const line = verdict.decision === "allow" ? copy.reviewer.allowed(request.summary, verdict.reason) : copy.reviewer.escalated(request.summary, verdict.reason);
  await hub.addMessage(agentId, "activity", line, runId, undefined, undefined, undefined, undefined, undefined, undefined, audience).catch((error) => log("reviewer_activity_error", { agentId, error: String(error) }));
  if (verdict.decision === "escalate") {
    if (stepsAside([verdict.decision, ...recent])) await hub.addMessage(agentId, "activity", copy.reviewer.steppedAside, runId, undefined, undefined, undefined, undefined, undefined, undefined, audience).catch(() => undefined);
    return { kind: "ask", fields: [...request.fields, { label: REVIEWER_FIELD, value: verdict.reason }] };
  }
  const id = await hub.approvals.createReviewed(agentId, request, approval.lifetimeSeconds, approval.payloadHash, approval.grant, brainText.reviewerApproved(verdict.reason));
  return { kind: "approved", id };
}
