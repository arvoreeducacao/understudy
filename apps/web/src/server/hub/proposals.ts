import { and, desc, eq, gt, inArray, ne } from "drizzle-orm";
import { DEFAULT_ASK_FIRST_RUNS, type Recipe } from "@understudy/protocol";
import { getDb, schema } from "@/lib/db";
import type { ProposalOrigin } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { newId } from "@/lib/ids";
import { messages as copy } from "@/lib/messages";
import { coveredBy, REPEAT_WINDOW_MS, repeatedAsk, sameTask } from "@/lib/repetition";
import { describeSchedule } from "@/lib/schedule";
import { agentTabPath } from "@/lib/workspace-tabs";
import type { Hub } from "../hub";
import type { ProposalView } from "../hub-types";
import { agentIdentity, escapeSlack, postMessage, sendDirectMessage, slackCall, slackEnabled, slackInteractive } from "../slack";
import { activeThread } from "../slack-threads";
import { taskLink } from "../task-tools";
import { toProposalView } from "@/lib/views";
import { log } from "./shared";

export const MAX_PENDING_PROPOSALS = 3;
export const DISMISSED_QUIET_MS = 30 * 24 * 60 * 60 * 1000;
const HISTORY_LIMIT = 400;
const SLACK_STEPS = 12;

type Row = typeof schema.taskProposals.$inferSelect;

export type ProposalInput = { recipe: Recipe; cron: string | null; timezone: string; reason: string; origin: ProposalOrigin };

export type ProposeResult =
  | { ok: true; id: string; replaced: boolean }
  | { ok: false; reason: "dismissed"; at: Date }
  | { ok: false; reason: "exists"; recipeTitle: string }
  | { ok: false; reason: "too_many" };

export function proposalBlocks(view: ProposalView, interactive: boolean) {
  const t = copy.proposals;
  const steps = view.recipe.steps.slice(0, SLACK_STEPS).map((step, i) => `${i + 1}. ${escapeSlack(step.text)}${step.mode === "ask" ? ` :lock: _${t.askFirst}_` : ""}`);
  if (view.recipe.steps.length > SLACK_STEPS) steps.push(`_${t.moreSteps(view.recipe.steps.length - SLACK_STEPS)}_`);
  const fields = [
    { type: "mrkdwn", text: `*${t.when}*\n${escapeSlack(describeSchedule(view.cron))}` },
    ...(view.recipe.questions.length ? [{ type: "mrkdwn", text: `*${t.inputs}*\n${view.recipe.questions.slice(0, 5).map((q) => `• ${escapeSlack(q.text)}`).join("\n")}`.slice(0, 1900) }] : []),
  ];
  const link = `${env.publicUrl}${agentTabPath(view.agentId, "computer")}`;
  return [
    { type: "section", text: { type: "mrkdwn", text: `*${t.title}*\n${escapeSlack(view.reason)}`.slice(0, 2900) } },
    { type: "section", text: { type: "mrkdwn", text: `*${escapeSlack(view.recipe.title)}*\n_${escapeSlack(view.recipe.trigger)}_`.slice(0, 2900) } },
    ...(steps.length ? [{ type: "section", text: { type: "mrkdwn", text: steps.join("\n").slice(0, 2900) } }] : []),
    { type: "section", fields },
    { type: "context", elements: [{ type: "mrkdwn", text: t.firstRuns(view.recipe.askFirstRuns) }] },
    {
      type: "actions",
      elements: [
        ...(interactive
          ? [
              { type: "button", action_id: "proposal_save", text: { type: "plain_text", text: t.save }, value: view.id, style: "primary" },
              { type: "button", action_id: "proposal_dismiss", text: { type: "plain_text", text: t.dismiss }, value: view.id },
            ]
          : []),
        { type: "button", action_id: "open", text: { type: "plain_text", text: copy.slack.openPanel }, url: link, ...(interactive ? {} : { style: "primary" }) },
      ],
    },
  ];
}

export class Proposals {
  constructor(private hub: Hub) {}

  async repeatOf(agentId: string, authorId: string, text: string, excludeMessageId?: string) {
    const db = getDb();
    const since = new Date(Date.now() - REPEAT_WINDOW_MS);
    const history = await db
      .select({ id: schema.messages.id, text: schema.messages.text, at: schema.messages.createdAt })
      .from(schema.messages)
      .where(and(eq(schema.messages.agentId, agentId), eq(schema.messages.role, "user"), eq(schema.messages.authorId, authorId), gt(schema.messages.createdAt, since)))
      .orderBy(desc(schema.messages.createdAt))
      .limit(HISTORY_LIMIT);
    const repeat = repeatedAsk(text, history.filter((row) => row.id !== excludeMessageId));
    if (!repeat) return null;
    const recipes = await db.select({ recipe: schema.recipes.recipe }).from(schema.recipes).where(eq(schema.recipes.agentId, agentId));
    const proposals = await db
      .select({ recipe: schema.taskProposals.recipe })
      .from(schema.taskProposals)
      .where(and(eq(schema.taskProposals.agentId, agentId), ne(schema.taskProposals.status, "saved"), gt(schema.taskProposals.createdAt, new Date(Date.now() - DISMISSED_QUIET_MS))));
    if (coveredBy(text, [...recipes, ...proposals].map((row) => row.recipe))) return null;
    return repeat;
  }

  async propose(agentId: string, input: ProposalInput): Promise<ProposeResult> {
    const db = getDb();
    const recipes = await db.select({ recipe: schema.recipes.recipe }).from(schema.recipes).where(eq(schema.recipes.agentId, agentId));
    const existing = recipes.find((row) => sameTask(row.recipe, input.recipe));
    if (existing) return { ok: false, reason: "exists", recipeTitle: existing.recipe.title };
    const recent = await db
      .select()
      .from(schema.taskProposals)
      .where(and(eq(schema.taskProposals.agentId, agentId), inArray(schema.taskProposals.status, ["pending", "dismissed"]), gt(schema.taskProposals.createdAt, new Date(Date.now() - DISMISSED_QUIET_MS))))
      .orderBy(desc(schema.taskProposals.createdAt));
    const dismissed = recent.find((row) => row.status === "dismissed" && sameTask(row.recipe, input.recipe));
    if (dismissed) return { ok: false, reason: "dismissed", at: dismissed.answeredAt ?? dismissed.createdAt };
    const recipe = { ...input.recipe, askFirstRuns: DEFAULT_ASK_FIRST_RUNS };
    const askedBy = this.hub.turnAudience(agentId);
    const pending = recent.filter((row) => row.status === "pending");
    const twin = pending.find((row) => row.askedBy === askedBy && sameTask(row.recipe, input.recipe));
    if (twin) {
      const [row] = await db
        .update(schema.taskProposals)
        .set({ recipe, cron: input.cron, timezone: input.timezone, reason: input.reason })
        .where(and(eq(schema.taskProposals.id, twin.id), eq(schema.taskProposals.status, "pending")))
        .returning();
      if (row) {
        this.hub.broadcastCard(agentId, { type: "proposal", proposal: toProposalView(row) }, row.askedBy);
        await this.updateSlack(row).catch((error) => log("proposal_slack_error", { error: String(error) }));
        log("proposal_updated", { agentId, proposalId: row.id });
        return { ok: true, id: row.id, replaced: true };
      }
    }
    if (pending.length >= MAX_PENDING_PROPOSALS) return { ok: false, reason: "too_many" };
    const id = newId("prp");
    const [row] = await db
      .insert(schema.taskProposals)
      .values({ id, agentId, recipe, cron: input.cron, timezone: input.timezone, reason: input.reason, origin: input.origin, askedBy })
      .returning();
    const view = toProposalView(row);
    await this.addCard(agentId, view, askedBy);
    log("proposal_created", { agentId, proposalId: id, origin: input.origin });
    this.notifySlack(agentId, view).catch((error) => log("proposal_slack_error", { error: String(error) }));
    return { ok: true, id, replaced: false };
  }

  private async addCard(agentId: string, view: ProposalView, askedBy: string | null) {
    const id = newId("msg");
    const createdAt = new Date();
    await getDb().insert(schema.messages).values({ id, agentId, role: "agent", text: "", proposalId: view.id, audienceId: askedBy, createdAt });
    this.hub.broadcastCard(agentId, { type: "chat", entry: { id, role: "agent", text: "", runId: null, via: null, streamId: null, at: createdAt.toISOString(), proposal: view } }, askedBy);
  }

  async answer(id: string, save: boolean, userId: string, options: { keepPaused?: boolean } = {}) {
    const db = getDb();
    const [row] = await db
      .update(schema.taskProposals)
      .set({ status: save ? "saved" : "dismissed", answeredBy: userId, answeredAt: new Date() })
      .where(and(eq(schema.taskProposals.id, id), eq(schema.taskProposals.status, "pending")))
      .returning();
    if (!row) return null;
    let saved = row;
    if (save) {
      const recipeId = newId("rcp");
      await db.insert(schema.recipes).values({
        id: recipeId,
        agentId: row.agentId,
        recipe: row.recipe,
        cron: row.cron,
        timezone: row.timezone,
        active: Boolean(row.cron) && !options.keepPaused,
      });
      [saved] = await db.update(schema.taskProposals).set({ recipeId }).where(eq(schema.taskProposals.id, id)).returning();
      await this.hub.addMessage(row.agentId, "system", copy.proposals.savedMessage(row.recipe.title, taskLink(row.agentId, recipeId)), null, undefined, undefined, undefined, undefined, undefined, undefined, row.askedBy);
    } else {
      await this.hub.addMessage(row.agentId, "system", copy.proposals.dismissedMessage(row.recipe.title), null, undefined, undefined, undefined, undefined, undefined, undefined, row.askedBy);
    }
    log("proposal_answered", { agentId: row.agentId, proposalId: id, saved: save });
    this.hub.broadcastCard(row.agentId, { type: "proposal", proposal: toProposalView(saved) }, row.askedBy);
    await this.updateSlack(saved, userId).catch((error) => log("proposal_slack_error", { error: String(error) }));
    return toProposalView(saved);
  }

  private async agentAndOwner(agentId: string) {
    const [row] = await getDb()
      .select({ id: schema.agents.id, name: schema.agents.name, ownerId: schema.user.id, email: schema.user.email })
      .from(schema.agents)
      .innerJoin(schema.user, eq(schema.user.id, schema.agents.ownerId))
      .where(eq(schema.agents.id, agentId));
    return row ?? null;
  }

  private async notifySlack(agentId: string, view: ProposalView) {
    if (!(await slackEnabled())) return;
    const agent = await this.agentAndOwner(agentId);
    if (!agent) return;
    const blocks = proposalBlocks(view, await slackInteractive());
    const text = copy.proposals.slackText(agent.name, view.recipe.title);
    const as = agentIdentity(agent);
    const thread = await activeThread(agentId);
    const result = (
      thread
        ? await postMessage({ channel: thread.channel, threadTs: thread.threadTs ?? undefined, text, blocks, as })
        : await sendDirectMessage({ id: agent.ownerId, email: agent.email }, text, blocks, as)
    ) as { ok: boolean; channel?: string; ts?: string };
    if (result.ok && result.channel && result.ts) {
      await getDb().update(schema.taskProposals).set({ slackChannel: result.channel, slackTs: result.ts }).where(eq(schema.taskProposals.id, view.id));
    }
  }

  private async updateSlack(row: Row, userId?: string) {
    if (!row.slackChannel || !row.slackTs) return;
    const view = toProposalView(row);
    if (row.status === "pending") {
      const agent = await this.agentAndOwner(row.agentId);
      if (!agent) return;
      await slackCall("chat.update", { channel: row.slackChannel, ts: row.slackTs, text: copy.proposals.slackText(agent.name, view.recipe.title), blocks: proposalBlocks(view, await slackInteractive()) });
      return;
    }
    const [person] = userId ? await getDb().select({ name: schema.user.name }).from(schema.user).where(eq(schema.user.id, userId)) : [];
    const by = escapeSlack(person?.name ?? "");
    const title = escapeSlack(row.recipe.title);
    const text = row.status === "saved" ? copy.proposals.slackSaved(title, by) : copy.proposals.slackDismissed(title, by);
    const link = row.recipeId ? `\n<${taskLink(row.agentId, row.recipeId)}|${copy.proposals.openTask}>` : "";
    await slackCall("chat.update", { channel: row.slackChannel, ts: row.slackTs, text, blocks: [{ type: "section", text: { type: "mrkdwn", text: `${text}${link}` } }] });
  }
}
