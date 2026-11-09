import { and, eq, inArray, sql } from "drizzle-orm";
import { normalizeRecipe, RUN_RECORD_MAX_SCREENSHOTS, type RunStep, type Usage } from "@understudy/protocol";
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

export type StalledRun = { id: string; agentId: string; startedAt: Date; lastSeen: Date; ranAt: Date; waiting: boolean; undelivered: boolean; lastActivity: string | null };

export class Runs {
  constructor(private hub: Hub) {}

  async start(recipeId: string, trigger: RunTrigger, options: { scheduledFor?: Date; input?: string; group?: { name: string; locale: string } } = {}) {
    const { scheduledFor, input, group } = options;
    const db = getDb();
    const [found] = await db
      .select({ recipe: schema.recipes, ownerStatus: schema.user.status, model: schema.agents.model })
      .from(schema.recipes)
      .innerJoin(schema.agents, eq(schema.agents.id, schema.recipes.agentId))
      .innerJoin(schema.user, eq(schema.user.id, schema.agents.ownerId))
      .where(eq(schema.recipes.id, recipeId));
    if (!found) return { ok: false as const, reason: "not_found" };
    if (found.ownerStatus !== "approved") return { ok: false as const, reason: "owner_inactive" };
    const recipe = found.recipe;
    const runId = newId("run");
    const inserted = await db
      .insert(schema.runs)
      .values({ id: runId, agentId: recipe.agentId, recipeId, trigger, input: input ?? null, scheduledFor: scheduledFor ?? null })
      .onConflictDoNothing()
      .returning();
    if (inserted.length === 0) return { ok: false as const, reason: "duplicate" };
    const steps = normalizeRecipe(recipe.recipe);
    const approvalsRequired = approvalsRequiredFor({ recipe: steps, askAlways: recipe.askAlways, runsDone: recipe.runsDone, trigger });
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
        lastSeen: sql<Date | string>`greatest(
          "runs"."started_at",
          (select max(m.created_at) from messages m where m.agent_id = "runs"."agent_id" and m.created_at >= "runs"."started_at" and m.role <> 'user'),
          (select max(t.created_at) from tool_calls t where t.agent_id = "runs"."agent_id" and t.created_at >= "runs"."started_at"),
          (select max(coalesce(a.answered_at, a.created_at)) from approvals a where a.agent_id = "runs"."agent_id" and coalesce(a.answered_at, a.created_at) >= "runs"."started_at")
        )`,
        ranAt: sql<Date | string>`greatest("runs"."started_at", (select max(m.created_at) from messages m where m.agent_id = "runs"."agent_id" and m.created_at >= "runs"."started_at" and m.run_id = "runs"."id"))`,
        waiting: sql<boolean>`exists (select 1 from approvals a where a.agent_id = "runs"."agent_id" and a.status = 'pending' and (a.expires_at is null or a.expires_at > now()))`,
        undelivered: sql<boolean>`exists (select 1 from inbound_queue q where q.agent_id = "runs"."agent_id" and q.run_id = "runs"."id")`,
        lastActivity: sql<string | null>`(select m.text from messages m where m.agent_id = "runs"."agent_id" and m.created_at >= "runs"."started_at" and m.run_id = "runs"."id" and m.role in ('activity', 'agent') order by m.created_at desc limit 1)`,
      })
      .from(schema.runs)
      .where(eq(schema.runs.status, "running"))
      .limit(STALL_SCAN_LIMIT);
    return rows
      .map((row) => ({ ...row, lastSeen: new Date(row.lastSeen), ranAt: new Date(row.ranAt) }))
      .filter((row) => !row.waiting && !row.undelivered && now - row.lastSeen.getTime() >= quietMs);
  }

  async failStalled(now = Date.now()) {
    for (const run of await this.stalled(now)) {
      const summary = copy.runs.stalled(Math.round(STALL_MS / 60_000), formatWhen(run.ranAt), run.lastActivity?.replace(/\s+/g, " ").slice(0, 200) ?? null);
      const recent = now - run.ranAt.getTime() < STALL_NOTICE_MAX_AGE_MS;
      if (recent) await this.finish(run.agentId, run.id, false, summary);
      else await this.close(run.agentId, run.id, false, summary);
      const stopped = this.hub.sendToComputer(run.agentId, { type: "run_stop", runId: run.id, reason: summary });
      log("run_stalled", { runId: run.id, agentId: run.agentId, lastSeen: run.lastSeen.toISOString(), ranAt: run.ranAt.toISOString(), notified: recent, stopped });
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
