import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { cleanApprovalPolicy, normalizeRecipe, RUN_RECORD_MAX_SCREENSHOTS, type RunStep, type Usage } from "@understudy/protocol";
import { effectiveModel } from "@/lib/models";
import { approvalsRequiredFor, quotedInputTrigger } from "@/lib/run-policy";
import { brainText } from "@/lib/brain-text";
import { getDb, schema } from "@/lib/db";
import type { RunTrigger } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { formatWhen } from "@/lib/format";
import { messages as copy } from "@/lib/messages";
import type { Hub } from "../hub";
import { notifyRunFailure, type RunOutcome } from "../run-alerts";
import { relayRunFinished, relayRunStarted } from "../channels/relay";
import { log } from "./shared";

export const STALL_MS = 35 * 60 * 1000;
const STALL_NOTICE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STALL_SCAN_LIMIT = 500;
const STOP_RESEND_MS = 60 * 1000;
const STOP_MEMORY_MS = 24 * 60 * 60 * 1000;

export type StalledRun = {
  id: string;
  agentId: string;
  startedAt: Date;
  started: boolean;
  lastSeen: Date;
  activityAt: Date | null;
  lastActivity: string | null;
  lateAnswer: { summary: string; at: Date } | null;
};

type StallRow = {
  id: string;
  agentId: string;
  startedAt: Date;
  activityAt: Date | string | null;
  askedAt: Date | string | null;
  agentSeen: Date | string;
  runWaiting: boolean;
  agentWaiting: boolean;
  undelivered: boolean;
  lastActivity: string | null;
  lateSummary: string | null;
  lateAt: Date | string | null;
};

const asDate = (value: Date | string | null) => (value === null ? null : new Date(value));

export function stallVerdict(row: StallRow, now: number, quietMs: number): StalledRun | null {
  if (row.undelivered) return null;
  const activityAt = asDate(row.activityAt);
  const started = activityAt !== null;
  const askedAt = asDate(row.askedAt);
  const runSeen = new Date(Math.max(row.startedAt.getTime(), activityAt?.getTime() ?? 0, askedAt?.getTime() ?? 0));
  const lastSeen = started ? runSeen : new Date(Math.max(runSeen.getTime(), new Date(row.agentSeen).getTime()));
  if (started ? row.runWaiting : row.agentWaiting || row.runWaiting) return null;
  if (now - lastSeen.getTime() < quietMs) return null;
  const lateAt = asDate(row.lateAt);
  return {
    id: row.id,
    agentId: row.agentId,
    startedAt: row.startedAt,
    started,
    lastSeen,
    activityAt,
    lastActivity: row.lastActivity,
    lateAnswer: started && row.lateSummary && lateAt ? { summary: row.lateSummary, at: lateAt } : null,
  };
}

export class Runs {
  private stopsSent = new Map<string, { agentId: string; reason: string; at: number }>();
  private skipNoted = new Set<string>();

  constructor(private hub: Hub) {}

  resendStop(agentId: string, runId: string, reason: string, now = Date.now()) {
    const last = this.stopsSent.get(runId);
    if (last && now - last.at < STOP_RESEND_MS) return false;
    for (const [id, sent] of this.stopsSent) if (now - sent.at > STOP_MEMORY_MS) this.stopsSent.delete(id);
    this.stopsSent.set(runId, { agentId, reason, at: now });
    return this.hub.sendToComputer(agentId, { type: "run_stop", runId, reason: reason.slice(0, 1000) });
  }

  resendStopsFor(agentId: string, now = Date.now()) {
    let sent = 0;
    for (const [runId, stop] of this.stopsSent) {
      if (stop.agentId !== agentId || now - stop.at > STOP_MEMORY_MS) continue;
      if (this.hub.sendToComputer(agentId, { type: "run_stop", runId, reason: stop.reason.slice(0, 1000) })) sent += 1;
    }
    return sent;
  }

  noteRunSign(agentId: string, runId: string) {
    const stopped = this.stopsSent.get(runId);
    if (stopped && stopped.agentId === agentId) this.resendStop(agentId, runId, stopped.reason);
  }

  async runState(agentId: string, runId: string): Promise<"running" | "closed" | "missing"> {
    const [run] = await getDb()
      .select({ status: schema.runs.status, summary: schema.runs.summary })
      .from(schema.runs)
      .where(and(eq(schema.runs.id, runId), eq(schema.runs.agentId, agentId)));
    if (!run) return "missing";
    if (run.status === "running") return "running";
    this.resendStop(agentId, runId, run.summary ?? "");
    return "closed";
  }

  async closedRun(agentId: string, runId: string) {
    const [run] = await getDb()
      .select({ status: schema.runs.status, summary: schema.runs.summary })
      .from(schema.runs)
      .where(and(eq(schema.runs.id, runId), eq(schema.runs.agentId, agentId)));
    if (!run || run.status === "running") return null;
    this.resendStop(agentId, runId, run.summary ?? "");
    return run.summary ?? "";
  }

  async start(recipeId: string, trigger: RunTrigger, options: { scheduledFor?: Date; input?: string; group?: { name: string; locale: string } } = {}) {
    const { scheduledFor, input, group } = options;
    const db = getDb();
    const [found] = await db
      .select({ recipe: schema.recipes, ownerStatus: schema.user.status, model: schema.agents.model, approvalPolicy: schema.agents.approvalPolicy })
      .from(schema.recipes)
      .innerJoin(schema.agents, eq(schema.agents.id, schema.recipes.agentId))
      .innerJoin(schema.user, eq(schema.user.id, schema.agents.ownerId))
      .where(eq(schema.recipes.id, recipeId));
    if (!found) return { ok: false as const, reason: "not_found" };
    if (found.ownerStatus !== "approved") return { ok: false as const, reason: "owner_inactive" };
    const recipe = found.recipe;
    if (trigger === "schedule") {
      const [open] = await db
        .select({ id: schema.runs.id, startedAt: schema.runs.startedAt })
        .from(schema.runs)
        .where(and(eq(schema.runs.recipeId, recipeId), eq(schema.runs.status, "running")))
        .orderBy(asc(schema.runs.startedAt))
        .limit(1);
      if (open) {
        if (!this.skipNoted.has(open.id)) {
          this.skipNoted.add(open.id);
          await this.hub.addMessage(recipe.agentId, "system", copy.runs.skipped(recipe.recipe.title, formatWhen(open.startedAt)), open.id);
        }
        log("run_skipped", { recipeId, openRunId: open.id });
        return { ok: false as const, reason: "already_running" };
      }
    }
    const runId = newId("run");
    const inserted = await db
      .insert(schema.runs)
      .values({ id: runId, agentId: recipe.agentId, recipeId, trigger, input: input ?? null, scheduledFor: scheduledFor ?? null })
      .onConflictDoNothing()
      .returning();
    if (inserted.length === 0) return { ok: false as const, reason: "duplicate" };
    const steps = normalizeRecipe(recipe.recipe);
    const approvalsRequired = approvalsRequiredFor({ recipe: steps, askAlways: recipe.askAlways, runsDone: recipe.runsDone, trigger, mode: cleanApprovalPolicy(found.approvalPolicy).mode });
    if (this.hub.isOnline(recipe.agentId)) {
      await this.hub.addMessage(recipe.agentId, "system", copy.runs.started(recipe.recipe.title, trigger), runId);
    }
    const context = [trigger === "test" ? brainText.testContext : "", input ? brainText.runInput(trigger, input) : "", group ? brainText.groupSummary(group.name, group.locale) : ""].filter(Boolean).join("\n\n");
    const delivery = await this.hub.deliver(recipe.agentId, {
      type: "run_recipe",
      runId,
      recipe: steps,
      approvalsRequired,
      model: effectiveModel(found.model) ?? undefined,
      webhook: quotedInputTrigger(trigger),
      context: context || undefined,
    }, { source: "run", runId });
    log("run_started", { runId, recipeId, trigger, delivery: delivery.status });
    relayRunStarted(recipe.agentId, runId, recipe.recipe.title, steps.steps.map((step) => step.text)).catch((error) => log("slack_progress_error", { error: String(error) }));
    await db
      .update(schema.agents)
      .set({ state: "working", stateNote: recipe.recipe.title, updatedAt: new Date() })
      .where(eq(schema.agents.id, recipe.agentId));
    this.hub.broadcast(recipe.agentId, { type: "state", state: "working", note: recipe.recipe.title });
    return { ok: true as const, runId };
  }

  private async close(agentId: string, runId: string, ok: boolean, summary: string, usage?: Usage) {
    const db = getDb();
    const [run] = await db
      .update(schema.runs)
      .set({
        status: ok ? "ok" : "failed",
        summary,
        finishedAt: new Date(),
        ...(usage ? { usage: { inputTokens: Number(usage.inputTokens) || 0, outputTokens: Number(usage.outputTokens) || 0, costUsd: usage.costUsd } } : {}),
      })
      .where(and(eq(schema.runs.id, runId), eq(schema.runs.agentId, agentId), eq(schema.runs.status, "running")))
      .returning();
    if (!run) {
      log("run_finish_ignored", { runId, agentId });
      return null;
    }
    this.skipNoted.delete(runId);
    await db
      .update(schema.approvals)
      .set({ status: "expired", answeredAt: new Date() })
      .where(and(eq(schema.approvals.runId, runId), eq(schema.approvals.agentId, agentId), eq(schema.approvals.status, "pending")));
    this.hub.broadcast(agentId, { type: "run_finished", runId, ok, summary });
    return run;
  }

  async finish(agentId: string, runId: string, ok: boolean, summary: string, usage?: Usage, outcome?: RunOutcome) {
    const db = getDb();
    const run = await this.close(agentId, runId, ok, summary, usage);
    if (!run) return;
    if (run.recipeId && ok && run.trigger !== "test") {
      await db
        .update(schema.recipes)
        .set({ runsDone: sql`${schema.recipes.runsDone} + 1` })
        .where(eq(schema.recipes.id, run.recipeId));
    }
    const state = ok ? "done" : "stuck";
    await db.update(schema.agents).set({ state, stateNote: summary, updatedAt: new Date() }).where(eq(schema.agents.id, agentId));
    this.hub.broadcast(agentId, { type: "state", state, note: summary });
    await this.hub.addMessage(agentId, "system", ok ? copy.runs.finishedOk(summary) : copy.runs.finishedFail(summary), runId);
    if (!ok) notifyRunFailure(agentId, runId, outcome).catch((error) => log("run_notice_error", { error: String(error) }));
    if (run.recipeId) {
      const [recipe] = await db.select({ recipe: schema.recipes.recipe }).from(schema.recipes).where(eq(schema.recipes.id, run.recipeId));
      if (recipe && run.trigger === "handoff") {
        await this.hub.rooms.relayRunClosed(agentId, runId, recipe.recipe.title, ok, summary).catch((error) => log("room_relay_error", { runId, error: String(error) }));
      }
      if (recipe) {
        await relayRunFinished(agentId, runId, recipe.recipe.title, recipe.recipe.steps.map((step) => step.text), ok, summary).catch((error) => log("slack_progress_error", { error: String(error) }));
      }
    }
  }

  async stalled(now = Date.now(), quietMs = STALL_MS): Promise<StalledRun[]> {
    const rows = await getDb()
      .select({
        id: schema.runs.id,
        agentId: schema.runs.agentId,
        startedAt: schema.runs.startedAt,
        activityAt: sql<Date | string | null>`(select max(m.created_at) from messages m where m.agent_id = "runs"."agent_id" and m.created_at >= "runs"."started_at" and m.run_id = "runs"."id" and m.role in ('activity', 'agent'))`,
        askedAt: sql<Date | string | null>`(select max(coalesce(a.answered_at, case when a.expires_at <= now() then a.expires_at else a.created_at end)) from approvals a where a.agent_id = "runs"."agent_id" and a.run_id = "runs"."id")`,
        agentSeen: sql<Date | string>`greatest(
          "runs"."started_at",
          (select max(m.created_at) from messages m where m.agent_id = "runs"."agent_id" and m.created_at >= "runs"."started_at" and m.role in ('activity', 'agent')),
          (select max(coalesce(a.answered_at, a.created_at)) from approvals a where a.agent_id = "runs"."agent_id" and coalesce(a.answered_at, a.created_at) >= "runs"."started_at")
        )`,
        runWaiting: sql<boolean>`exists (select 1 from approvals a where a.agent_id = "runs"."agent_id" and a.run_id = "runs"."id" and a.status = 'pending' and (a.expires_at > now() or (a.expires_at is null and a.created_at > now() - interval '24 hours')))`,
        agentWaiting: sql<boolean>`exists (select 1 from approvals a where a.agent_id = "runs"."agent_id" and a.status = 'pending' and (a.expires_at > now() or (a.expires_at is null and a.created_at > now() - interval '24 hours')))`,
        undelivered: sql<boolean>`exists (select 1 from inbound_queue q where q.agent_id = "runs"."agent_id" and q.run_id = "runs"."id")`,
        lastActivity: sql<string | null>`(select m.text from messages m where m.agent_id = "runs"."agent_id" and m.created_at >= "runs"."started_at" and m.run_id = "runs"."id" and m.role in ('activity', 'agent') order by m.created_at desc limit 1)`,
        lateSummary: sql<string | null>`(select a.summary from approvals a where a.agent_id = "runs"."agent_id" and a.run_id = "runs"."id" and a.status in ('approved', 'denied') order by a.answered_at desc nulls last limit 1)`,
        lateAt: sql<Date | string | null>`(select a.answered_at from approvals a where a.agent_id = "runs"."agent_id" and a.run_id = "runs"."id" and a.status in ('approved', 'denied') order by a.answered_at desc nulls last limit 1)`,
      })
      .from(schema.runs)
      .where(eq(schema.runs.status, "running"))
      .limit(STALL_SCAN_LIMIT);
    return rows.map((row) => stallVerdict(row, now, quietMs)).filter((run): run is StalledRun => run !== null);
  }

  stallSummary(run: StalledRun) {
    const minutes = Math.round(STALL_MS / 60_000);
    if (!run.started || !run.activityAt) return copy.runs.neverStarted(minutes, formatWhen(run.lastSeen));
    const late = run.lateAnswer && run.lateAnswer.at > run.activityAt ? { summary: run.lateAnswer.summary.replace(/\s+/g, " ").slice(0, 200), at: formatWhen(run.lateAnswer.at) } : null;
    return copy.runs.stalled(minutes, formatWhen(run.activityAt), run.lastActivity?.replace(/\s+/g, " ").slice(0, 200) ?? null, late);
  }

  async failStalled(now = Date.now()) {
    for (const run of await this.stalled(now)) {
      const summary = this.stallSummary(run);
      const recent = now - run.lastSeen.getTime() < STALL_NOTICE_MAX_AGE_MS;
      if (recent) await this.finish(run.agentId, run.id, false, summary);
      else await this.close(run.agentId, run.id, false, summary);
      const stopped = this.resendStop(run.agentId, run.id, summary, now);
      log("run_stalled", { runId: run.id, agentId: run.agentId, started: run.started, lastSeen: run.lastSeen.toISOString(), notified: recent, stopped });
    }
  }

  async saveRecord(agentId: string, runId: string, steps: RunStep[], unusual: string[]) {
    const db = getDb();
    const [run] = await db
      .select({ id: schema.runs.id })
      .from(schema.runs)
      .where(and(eq(schema.runs.id, runId), eq(schema.runs.agentId, agentId)));
    if (!run) return;
    const claimed = [...new Set(steps.map((step) => step.approvalId).filter((id): id is string => Boolean(id)))].slice(0, 500);
    const owned = claimed.length
      ? new Set(
          (
            await db
              .select({ id: schema.approvals.id })
              .from(schema.approvals)
              .where(and(eq(schema.approvals.agentId, agentId), inArray(schema.approvals.id, claimed)))
          ).map((row) => row.id),
        )
      : new Set<string>();
    let shots = 0;
    const clean = steps.slice(0, 500).map((step) => {
      const keep = step.screenshotJpegBase64 && shots < RUN_RECORD_MAX_SCREENSHOTS;
      if (keep) shots += 1;
      return {
        at: Number(step.at) || Date.now(),
        text: String(step.text ?? "").slice(0, 2000),
        approvalId: step.approvalId && owned.has(step.approvalId) ? step.approvalId : undefined,
        screenshotJpegBase64: keep ? step.screenshotJpegBase64 : undefined,
      };
    });
    const notes = unusual.slice(0, 50).map((u) => String(u).slice(0, 1000));
    await db
      .insert(schema.runRecords)
      .values({ runId, steps: clean, unusual: notes })
      .onConflictDoUpdate({ target: schema.runRecords.runId, set: { steps: clean, unusual: notes } });
  }
}
