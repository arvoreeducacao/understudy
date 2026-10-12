import { and, desc, eq, gt, inArray, isNotNull, ne } from "drizzle-orm";
import { env } from "@/lib/env";
import { getDb, schema } from "@/lib/db";
import type { BrainStatus } from "@/lib/db/schema";
import { messages as copy } from "@/lib/messages";
import { sendPush, type PushPayload } from "./push";
import { agentIdentity, escapeSlack, replaceDirectNotice, slackEnabled, slackUserIdFor, type SlackIdentity, type SlackRecipient } from "./slack";
import { log } from "./hub/shared";

export type RunOutcome = "stopped" | "signed_out";

export type RunFailureNotice = {
  key: string;
  agentId: string;
  agentName: string;
  brain: string;
  task: string;
  summary: string;
  runId: string;
  streak: number;
  signedOut: boolean;
};

export function failureStreak(statuses: string[]): number {
  let count = 0;
  for (const status of statuses) {
    if (status !== "failed") break;
    count++;
  }
  return count;
}

export function brainName(brain: string): string {
  return brain === "codex" ? "Codex" : "Claude";
}

export function brainSignedOut(brain: string, brains: BrainStatus[]): boolean {
  return brains.some((status) => status.brain === brain && !status.loggedIn);
}

export function settingsPath(agentId: string): string {
  return `/agents/${agentId}?tab=settings`;
}

export function noticePath(notice: Pick<RunFailureNotice, "agentId" | "runId" | "signedOut">): string {
  return notice.signedOut ? settingsPath(notice.agentId) : `/runs/${notice.runId}`;
}

export function runFailureSlackText(notice: RunFailureNotice, baseUrl: string): string {
  const t = copy.runAlerts;
  const lines = [t.failed(escapeSlack(notice.agentName), escapeSlack(notice.task))];
  if (notice.streak > 1) lines.push(t.repeated(notice.streak));
  lines.push(notice.signedOut ? t.signedOut(brainName(notice.brain)) : `> ${escapeSlack(notice.summary.replace(/\s+/g, " ").slice(0, 300))}`);
  const label = notice.signedOut ? t.signInAction(brainName(notice.brain)) : t.seeRun;
  lines.push(`<${baseUrl}${noticePath(notice)}|${label}>`);
  return lines.join("\n");
}

export function runFailurePush(notice: RunFailureNotice): PushPayload {
  const t = copy.runAlerts;
  return {
    title: t.pushTitle(notice.agentName, notice.streak),
    body: (notice.signedOut ? t.signedOut(brainName(notice.brain)) : notice.summary).slice(0, 180),
    url: noticePath(notice),
    tag: `run-failed-${notice.key}`,
  };
}

export type NoticeDeps = {
  push: (userIds: string[], payload: PushPayload) => Promise<void>;
  slackUser: (owner: SlackRecipient) => Promise<string | null>;
  replace: (userId: string, key: string, text: string, as?: SlackIdentity) => Promise<{ ok: boolean; error?: string }>;
  baseUrl: string;
};

const liveDeps: NoticeDeps = {
  push: sendPush,
  slackUser: async (owner) => ((await slackEnabled()) ? slackUserIdFor(owner) : null),
  replace: (userId, key, text, as) => replaceDirectNotice(userId, key, text, as),
  get baseUrl() {
    return env.publicUrl;
  },
};

export async function deliverRunFailureNotice(notice: RunFailureNotice, owner: SlackRecipient, deps: NoticeDeps = liveDeps) {
  await deps.push([owner.id], runFailurePush(notice)).catch((error) => log("push_error", { error: String(error) }));
  const slackUser = await deps.slackUser(owner).catch(() => null);
  if (!slackUser) return { slack: false };
  const sent = await deps.replace(slackUser, notice.key, runFailureSlackText(notice, deps.baseUrl), agentIdentity({ id: notice.agentId, name: notice.agentName }));
  if (!sent.ok) log("run_notice_slack_failed", { agentId: notice.agentId, runId: notice.runId, error: sent.error });
  return { slack: sent.ok };
}

const STREAK_WINDOW = 50;

export async function notifyRunFailure(agentId: string, runId: string, outcome?: RunOutcome, deps: NoticeDeps = liveDeps) {
  if (outcome === "stopped") return;
  const db = getDb();
  const [found] = await db
    .select({ run: schema.runs, agent: schema.agents, owner: { id: schema.user.id, email: schema.user.email }, task: schema.recipes.recipe })
    .from(schema.runs)
    .innerJoin(schema.agents, eq(schema.agents.id, schema.runs.agentId))
    .innerJoin(schema.user, eq(schema.user.id, schema.agents.ownerId))
    .leftJoin(schema.recipes, eq(schema.recipes.id, schema.runs.recipeId))
    .where(and(eq(schema.runs.id, runId), eq(schema.runs.agentId, agentId)));
  if (!found || found.run.status !== "failed" || found.run.trigger === "test") return;
  const { run, agent, owner } = found;
  let streak = 1;
  if (run.recipeId) {
    const recent = await db
      .select({ status: schema.runs.status })
      .from(schema.runs)
      .where(and(eq(schema.runs.recipeId, run.recipeId), ne(schema.runs.trigger, "test"), ne(schema.runs.status, "running")))
      .orderBy(desc(schema.runs.startedAt))
      .limit(STREAK_WINDOW);
    streak = Math.max(1, failureStreak(recent.map((row) => row.status)));
  }
  const notice: RunFailureNotice = {
    key: `${agentId}:${run.recipeId ?? run.id}`,
    agentId,
    agentName: agent.name,
    brain: agent.brain,
    task: found.task?.title ?? agent.name,
    summary: run.summary ?? "",
    runId,
    streak,
    signedOut: outcome === "signed_out" || brainSignedOut(agent.brain, agent.brains),
  };
  return deliverRunFailureNotice(notice, owner, deps);
}

export type FailureRow = {
  runId: string;
  recipeId: string;
  status: string;
  summary: string | null;
  finishedAt: Date | null;
  task: string;
  agent: { id: string; name: string; look: unknown; brain: string; brains: BrainStatus[] };
};

export type OpenFailure = { latest: FailureRow; streak: number; signedOut: boolean };

export function openFailures(rows: FailureRow[]): OpenFailure[] {
  const byRecipe = new Map<string, FailureRow[]>();
  for (const row of rows) byRecipe.set(row.recipeId, [...(byRecipe.get(row.recipeId) ?? []), row]);
  const open: OpenFailure[] = [];
  for (const recipeRows of byRecipe.values()) {
    const streak = failureStreak(recipeRows.map((row) => row.status));
    if (streak === 0) continue;
    const latest = recipeRows[0];
    open.push({ latest, streak, signedOut: brainSignedOut(latest.agent.brain, latest.agent.brains) });
  }
  return open;
}

const OPEN_FAILURE_DAYS = 14;

export async function loadOpenFailures(agentIds: string[]): Promise<OpenFailure[]> {
  if (!agentIds.length) return [];
  const since = new Date(Date.now() - OPEN_FAILURE_DAYS * 86_400_000);
  const rows = await getDb()
    .select({
      runId: schema.runs.id,
      recipeId: schema.runs.recipeId,
      status: schema.runs.status,
      summary: schema.runs.summary,
      finishedAt: schema.runs.finishedAt,
      recipe: schema.recipes.recipe,
      agent: { id: schema.agents.id, name: schema.agents.name, look: schema.agents.look, brain: schema.agents.brain, brains: schema.agents.brains },
    })
    .from(schema.runs)
    .innerJoin(schema.recipes, eq(schema.recipes.id, schema.runs.recipeId))
    .innerJoin(schema.agents, eq(schema.agents.id, schema.runs.agentId))
    .where(and(inArray(schema.runs.agentId, agentIds), isNotNull(schema.runs.recipeId), ne(schema.runs.trigger, "test"), ne(schema.runs.status, "running"), gt(schema.runs.startedAt, since)))
    .orderBy(desc(schema.runs.startedAt))
    .limit(500);
  return openFailures(rows.map((row) => ({ ...row, recipeId: row.recipeId!, task: row.recipe.title })));
}
