import { createHash } from "node:crypto";
import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { brainText } from "@/lib/brain-text";
import type { ApprovalGrant, ApprovalReview } from "@/lib/db/schema";
import { messages as copy } from "@/lib/messages";
import type { Hub } from "./hub";
import { REVIEWER_FIELD, reviewerFromEnv, reviewPrompt, stepsAside, type Reviewer, type ReviewField, type ReviewInput, type ReviewVerdict } from "./reviewer";

export type ReviewRequest = { summary: string; fields: ReviewField[]; runId?: string; stepId?: string };

const OWNER_MESSAGES = 3;
const REMEMBERED_VERDICTS = 500;

const remembered = new Map<string, ReviewVerdict>();

function verdictKey(agentId: string, conversation: string, input: ReviewInput, now: Date) {
  return createHash("sha256").update(JSON.stringify([startOfDay(now).toISOString(), agentId, conversation, reviewPrompt(input)])).digest("hex");
}

function remember(key: string, verdict: ReviewVerdict) {
  if (verdict.from !== "model") return;
  remembered.delete(key);
  remembered.set(key, verdict);
  if (remembered.size > REMEMBERED_VERDICTS) remembered.delete(remembered.keys().next().value as string);
}

export function forgetReviewVerdicts() {
  remembered.clear();
}

function log(event: string, data: Record<string, unknown>) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
}

function startOfDay(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export async function reviewContext(hub: Hub, agent: { id: string; ownerId: string }, runId: string | undefined): Promise<Pick<ReviewInput, "ownerRequest" | "task">> {
  const agentId = agent.id;
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
  const author = hub.turnAudience(agentId) ?? agent.ownerId;
  const said = await db
    .select({ text: schema.messages.text })
    .from(schema.messages)
    .where(and(eq(schema.messages.agentId, agentId), eq(schema.messages.role, "user"), isNull(schema.messages.runId), eq(schema.messages.authorId, author), isNull(schema.messages.sender), gte(schema.messages.createdAt, startOfDay(new Date()))))
    .orderBy(desc(schema.messages.createdAt))
    .limit(OWNER_MESSAGES);
  return { ownerRequest: said.reverse().map((row) => row.text).join("\n") };
}

export type ReviewOutcome = { kind: "approved"; id: string } | { kind: "ask"; fields: ReviewField[]; review?: ApprovalReview };

export async function autoReview(
  hub: Hub,
  agent: { id: string; ownerId: string },
  request: ReviewRequest,
  approval: { lifetimeSeconds: number; payloadHash?: string; grant?: ApprovalGrant },
  reviewer: Reviewer | null = reviewerFromEnv(),
): Promise<ReviewOutcome> {
  const agentId = agent.id;
  const runId = request.runId ?? null;
  const asked = { kind: "ask" as const, fields: request.fields };
  if (!reviewer || request.stepId) return asked;
  const recent = await hub.approvals.recentReviews(agentId, { runId, askedBy: runId ? null : hub.turnAudience(agentId), since: startOfDay(new Date()) });
  if (stepsAside(recent)) {
    log("reviewer_stepped_aside", { agentId, runId });
    return asked;
  }
  const context = await reviewContext(hub, agent, request.runId);
  const input = { ...context, action: { summary: request.summary, fields: request.fields } };
  const audience = runId ? null : hub.turnAudience(agentId);
  const now = new Date();
  const key = verdictKey(agentId, runId ?? `chat:${audience ?? agent.ownerId}`, input, now);
  const known = remembered.get(key);
  const verdict = known ?? (await reviewer.review(input));
  if (!known) remember(key, verdict);
  log("reviewer_decision", { agentId, runId, decision: verdict.decision, model: verdict.model, ...(known ? { remembered: true } : {}) });
  const line = verdict.decision === "allow" ? copy.reviewer.allowed(request.summary, verdict.reason) : copy.reviewer.escalated(request.summary, verdict.reason);
  await hub.addMessage(agentId, "activity", line, runId, undefined, undefined, undefined, undefined, undefined, undefined, audience).catch((error) => log("reviewer_activity_error", { agentId, error: String(error) }));
  if (verdict.decision === "escalate") {
    if (stepsAside([verdict.decision, ...recent])) await hub.addMessage(agentId, "activity", copy.reviewer.steppedAside, runId, undefined, undefined, undefined, undefined, undefined, undefined, audience).catch(() => undefined);
    return { kind: "ask", fields: [...request.fields, { label: REVIEWER_FIELD, value: verdict.reason }], review: { decision: "escalate", reason: verdict.reason } };
  }
  const id = await hub.approvals.createReviewed(agentId, request, approval.lifetimeSeconds, approval.payloadHash, approval.grant, brainText.reviewerApproved(verdict.reason), verdict.reason);
  return { kind: "approved", id };
}
