import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { brainText } from "@/lib/brain-text";
import { cleanApprovalPolicy, type ApprovalRequest } from "@understudy/protocol";
import { UNANSWERED_AFTER_MS, unansweredOutcome } from "@/lib/run-policy";
import { ESCALATIONS_BEFORE_STEPPING_ASIDE, REVIEWER_FIELD } from "../reviewer";
import { env } from "@/lib/env";
import { getDb, schema } from "@/lib/db";
import { storableJson, storableText } from "@/lib/db/storable";
import { newId } from "@/lib/ids";
import { messages as copy } from "@/lib/messages";
import type { Hub } from "../hub";
import { sendPush } from "../push";
import { notifyApprovalOnChannel } from "../channels/approval-notify";
import { dropFromAgentChannelLists } from "../channels/store";
import { slackApprovalMessage } from "../channels/slack/adapter";
import type { ApprovalView } from "../hub-types";
import { agentIdentity, escapeSlack, sendDirectMessage } from "../slack";
import { log, type Answer } from "./shared";
import { grantTool } from "../tool-access";
import { grantAllowEntry } from "../approval-modes";
import { allowEntryOf, alwaysAllowOf } from "@/lib/always-allow";
import type { ApprovalGrant, ApprovalVia } from "@/lib/db/schema";
import { closeApprovalOnSlack, rememberApprovalMessage } from "../approval-slack";
import { guestTurn } from "../slack-askers";

const RUN_APPROVALS_LIMIT = 100;
const REMIND_AFTER_MS = 60 * 60 * 1000;
const REMIND_WINDOW_MS = 10 * 60 * 1000;

export class Approvals {
  private waiters = new Map<string, Set<(answer: Answer) => void>>();
  private reminded = new Set<string>();

  constructor(private hub: Hub) {}

  async create(
    agentId: string,
    request: Partial<ApprovalRequest> & { summary: string },
    source: "mcp" | "computer",
    timeoutSeconds?: number,
    payloadHash?: string,
    grant?: ApprovalGrant,
  ) {
    const db = getDb();
    const id = newId("apr");
    const requestId = source === "computer" && request.id ? request.id : null;
    const expiresAt = timeoutSeconds ? new Date(Date.now() + timeoutSeconds * 1000) : null;
    const guest = !request.runId && guestTurn(agentId);
    const askedBy = request.runId || guest ? null : this.hub.turnAudience(agentId);
    const roomId = askedBy ? this.hub.turnRoom(agentId) : null;
    const row = {
      id,
      agentId,
      runId: request.runId || null,
      stepId: request.stepId ?? null,
      summary: storableText(request.summary),
      fields: storableJson(request.fields ?? []),
      source,
      requestId,
      payloadHash: payloadHash ?? null,
      grant: grant ?? null,
      askedBy,
      expiresAt,
    };
    await db.insert(schema.approvals).values(row);
    const [asker] = askedBy ? await db.select({ name: schema.user.name }).from(schema.user).where(eq(schema.user.id, askedBy)) : [];
    const note = askedBy ? copy.teams.waitingFor(asker?.name ?? "") : request.summary;
    await db
      .update(schema.agents)
      .set({ state: "waiting_you", stateNote: note, updatedAt: new Date() })
      .where(eq(schema.agents.id, agentId));
    const view: ApprovalView = {
      id,
      agentId,
      runId: row.runId,
      stepId: row.stepId,
      summary: row.summary,
      fields: row.fields,
      status: "pending",
      createdAt: new Date().toISOString(),
      ...(grant ? { alwaysAllow: alwaysAllowOf(grant) } : {}),
      ...(askedBy ? { forYou: true as const } : {}),
    };
    this.hub.broadcast(agentId, { type: "approval", approval: view }, askedBy);
    this.hub.broadcast(agentId, { type: "state", state: "waiting_you", note });
    log("approval_created", { agentId, approvalId: id, source, ...(askedBy ? { askedBy } : {}) });
    if (askedBy && roomId) this.hub.rooms.approvalRaised(agentId, roomId, id, request.summary, askedBy).catch((error) => log("room_approval_error", { agentId, error: String(error) }));
    this.notify(agentId, view, askedBy, guest).catch((error) => log("approval_notify_error", { error: String(error) }));
    return id;
  }

  async createReviewed(agentId: string, request: Partial<ApprovalRequest> & { summary: string }, timeoutSeconds: number, payloadHash: string | undefined, grant: ApprovalGrant | undefined, note: string) {
    const id = newId("apr");
    const now = new Date();
    const askedBy = request.runId ? null : this.hub.turnAudience(agentId);
    await getDb()
      .insert(schema.approvals)
      .values({
        id,
        agentId,
        runId: request.runId || null,
        stepId: request.stepId ?? null,
        summary: storableText(request.summary),
        fields: storableJson(request.fields ?? []),
        source: "mcp",
        payloadHash: payloadHash ?? null,
        grant: grant ?? null,
        askedBy,
        expiresAt: new Date(now.getTime() + timeoutSeconds * 1000),
        status: "approved",
        note: storableText(note),
        answeredAt: now,
        answeredVia: "reviewer",
      });
    log("approval_reviewed", { agentId, approvalId: id });
    return id;
  }

  async recentReviews(agentId: string, conversation: { runId: string | null; askedBy: string | null; since: Date }) {
    const rows = await getDb()
      .select({ via: schema.approvals.answeredVia })
      .from(schema.approvals)
      .where(
        and(
          eq(schema.approvals.agentId, agentId),
          conversation.runId
            ? eq(schema.approvals.runId, conversation.runId)
            : and(isNull(schema.approvals.runId), conversation.askedBy ? eq(schema.approvals.askedBy, conversation.askedBy) : isNull(schema.approvals.askedBy), gte(schema.approvals.createdAt, conversation.since)),
          or(eq(schema.approvals.answeredVia, "reviewer"), sql`${schema.approvals.fields} @> ${JSON.stringify([{ label: REVIEWER_FIELD }])}::jsonb`),
        ),
      )
      .orderBy(desc(schema.approvals.createdAt))
      .limit(ESCALATIONS_BEFORE_STEPPING_ASIDE);
    return rows.map((row) => (row.via === "reviewer" ? ("allow" as const) : ("escalate" as const)));
  }

  async openAsk(agentId: string, request: { runId: string; stepId?: string; summary: string; fields: ApprovalRequest["fields"]; payloadHash?: string }) {
    const [row] = await getDb()
      .select({ id: schema.approvals.id })
      .from(schema.approvals)
      .where(
        and(
          eq(schema.approvals.agentId, agentId),
          eq(schema.approvals.runId, request.runId),
          eq(schema.approvals.status, "pending"),
          or(isNull(schema.approvals.expiresAt), gt(schema.approvals.expiresAt, new Date())),
          request.stepId ? eq(schema.approvals.stepId, request.stepId) : isNull(schema.approvals.stepId),
          eq(schema.approvals.summary, storableText(request.summary)),
          sql`${schema.approvals.fields} = ${JSON.stringify(storableJson(request.fields))}::jsonb`,
          request.payloadHash ? eq(schema.approvals.payloadHash, request.payloadHash) : isNull(schema.approvals.payloadHash),
        ),
      )
      .orderBy(desc(schema.approvals.createdAt))
      .limit(1);
    if (row) log("approval_joined", { agentId, approvalId: row.id, runId: request.runId });
    return row?.id ?? null;
  }

  forRun(agentId: string, runId: string) {
    return getDb()
      .select({
        id: schema.approvals.id,
        stepId: schema.approvals.stepId,
        summary: schema.approvals.summary,
        status: schema.approvals.status,
        note: schema.approvals.note,
        expiresAt: schema.approvals.expiresAt,
      })
      .from(schema.approvals)
      .where(and(eq(schema.approvals.agentId, agentId), eq(schema.approvals.runId, runId)))
      .orderBy(asc(schema.approvals.createdAt))
      .limit(RUN_APPROVALS_LIMIT);
  }

  async remind(now = Date.now(), send: typeof sendDirectMessage = sendDirectMessage) {
    const due = await getDb()
      .select({ approval: schema.approvals, owner: { id: schema.user.id, email: schema.user.email }, agentName: schema.agents.name })
      .from(schema.approvals)
      .innerJoin(schema.agents, eq(schema.agents.id, schema.approvals.agentId))
      .innerJoin(schema.user, eq(schema.user.id, schema.agents.ownerId))
      .where(
        and(
          eq(schema.approvals.status, "pending"),
          isNotNull(schema.approvals.runId),
          lte(schema.approvals.createdAt, new Date(now - REMIND_AFTER_MS)),
          gte(schema.approvals.createdAt, new Date(now - REMIND_AFTER_MS - REMIND_WINDOW_MS)),
          or(isNull(schema.approvals.expiresAt), gt(schema.approvals.expiresAt, new Date(now))),
        ),
      )
      .limit(100);
    for (const { approval, owner, agentName } of due) {
      if (this.reminded.has(approval.id)) continue;
      this.reminded.add(approval.id);
      const text = copy.approvalReminder.slack(escapeSlack(agentName), escapeSlack(approval.summary), `${env.publicUrl}/runs/${approval.runId}`, `${env.publicUrl}/waiting`);
      const sent = await send(owner, text, undefined, agentIdentity({ id: approval.agentId, name: agentName })).catch((error) => ({ ok: false, error: String(error) }));
      log("approval_reminded", { approvalId: approval.id, agentId: approval.agentId, slack: sent.ok });
    }
    for (const id of this.reminded) if (!due.some((row) => row.approval.id === id)) this.reminded.delete(id);
  }

  async payloadHash(id: string, agentId: string) {
    const [row] = await getDb()
      .select({ hash: schema.approvals.payloadHash, status: schema.approvals.status })
      .from(schema.approvals)
      .where(and(eq(schema.approvals.id, id), eq(schema.approvals.agentId, agentId)));
    return row?.status === "approved" ? row.hash : null;
  }

  async useActionApproval(agentId: string, hash: string, maxAgeMs: number) {
    const db = getDb();
    const fresh = and(
      eq(schema.approvals.agentId, agentId),
      eq(schema.approvals.payloadHash, hash),
      eq(schema.approvals.status, "approved"),
      isNull(schema.approvals.usedAt),
      gt(schema.approvals.answeredAt, new Date(Date.now() - maxAgeMs)),
    );
    const candidate = db
      .select({ id: schema.approvals.id })
      .from(schema.approvals)
      .innerJoin(schema.runs, and(eq(schema.runs.id, schema.approvals.runId), eq(schema.runs.agentId, agentId), eq(schema.runs.status, "running")))
      .where(fresh)
      .orderBy(desc(schema.approvals.answeredAt))
      .limit(1);
    const [row] = await db
      .update(schema.approvals)
      .set({ usedAt: new Date() })
      .where(and(inArray(schema.approvals.id, candidate), fresh))
      .returning({ id: schema.approvals.id });
    if (row) log("approval_used", { agentId, approvalId: row.id });
    return row?.id ?? null;
  }

  async outcome(id: string, agentId: string) {
    const [row] = await getDb()
      .select({ status: schema.approvals.status, note: schema.approvals.note })
      .from(schema.approvals)
      .where(and(eq(schema.approvals.id, id), eq(schema.approvals.agentId, agentId)));
    return row ?? null;
  }

  wait(id: string, capMs: number) {
    return new Promise<Answer | null>((resolve) => {
      const set = this.waiters.get(id) ?? new Set<(answer: Answer) => void>();
      const done = (answer: Answer) => {
        clearTimeout(timer);
        resolve(answer);
      };
      const timer = setTimeout(() => {
        set.delete(done);
        if (set.size === 0) this.waiters.delete(id);
        resolve(null);
      }, capMs);
      set.add(done);
      this.waiters.set(id, set);
    });
  }

  private settle(id: string, answer: Answer) {
    const set = this.waiters.get(id);
    if (!set) return;
    this.waiters.delete(id);
    for (const done of set) done(answer);
  }

  async expire() {
    const expired = await getDb()
      .update(schema.approvals)
      .set({ status: "expired", answeredAt: new Date() })
      .where(and(eq(schema.approvals.status, "pending"), lt(schema.approvals.expiresAt, new Date())))
      .returning();
    for (const row of expired) {
      log("approval_expired", { approvalId: row.id, agentId: row.agentId });
      this.settle(row.id, { approved: false, status: "expired", note: brainText.expiredNote });
      await this.leaveChannelLists(row.agentId, row.id);
      if (row.source === "computer") {
        this.hub.sendToComputer(row.agentId, {
          type: "approval_answer",
          requestId: row.requestId ?? row.id,
          approved: false,
          note: brainText.expiredNote,
        });
      }
      this.hub.broadcast(row.agentId, { type: "approval_closed", id: row.id, status: "expired" });
      if (row.askedBy) await this.hub.rooms.approvalClosed(row.id, "expired");
      await this.closeOnSlack(row);
    }
  }

  async cancelPending(agentId: string, userId: string | null, scope?: { askedBy: string } | { exceptAskedBy: string }) {
    const asked = !scope ? undefined : "askedBy" in scope ? eq(schema.approvals.askedBy, scope.askedBy) : and(isNotNull(schema.approvals.askedBy), ne(schema.approvals.askedBy, scope.exceptAskedBy));
    const cancelled = await getDb()
      .update(schema.approvals)
      .set({ status: "cancelled", answeredBy: userId, answeredAt: new Date() })
      .where(and(eq(schema.approvals.agentId, agentId), eq(schema.approvals.status, "pending"), asked))
      .returning();
    for (const row of cancelled) {
      log("approval_cancelled", { approvalId: row.id, agentId });
      this.settle(row.id, { approved: false, status: "cancelled", note: brainText.stoppedNote });
      await this.leaveChannelLists(agentId, row.id);
      if (row.source === "computer") {
        this.hub.sendToComputer(agentId, { type: "approval_answer", requestId: row.requestId ?? row.id, approved: false, note: brainText.stoppedNote });
      }
      this.hub.broadcast(agentId, { type: "approval_closed", id: row.id, status: "cancelled" });
      if (row.askedBy) await this.hub.rooms.approvalClosed(row.id, "cancelled");
      await this.closeOnSlack(row);
    }
    return cancelled.length;
  }

  private async closeOnSlack(row: typeof schema.approvals.$inferSelect) {
    await closeApprovalOnSlack(row).catch((error) => log("approval_slack_close_error", { approvalId: row.id, error: String(error) }));
  }

  private async leaveChannelLists(agentId: string, approvalId: string) {
    await dropFromAgentChannelLists(agentId, "approvals", approvalId).catch((error) => log("approval_channel_list_error", { approvalId, error: String(error) }));
  }

  async status(id: string) {
    const [row] = await getDb().select({ status: schema.approvals.status }).from(schema.approvals).where(eq(schema.approvals.id, id));
    return row?.status ?? null;
  }

  async answer(id: string, approved: boolean, note: string | undefined, userId: string, always = false, via: ApprovalVia = "panel") {
    const db = getDb();
    const status = approved ? "approved" : "denied";
    const [row] = await db
      .update(schema.approvals)
      .set({ status, note: note ?? null, answeredBy: userId, answeredAt: new Date(), answeredVia: via })
      .where(and(eq(schema.approvals.id, id), eq(schema.approvals.status, "pending"), or(isNull(schema.approvals.askedBy), eq(schema.approvals.askedBy, userId))))
      .returning();
    if (!row) return false;
    log("approval_answered", { approvalId: id, agentId: row.agentId, status });
    if (approved && always && row.grant) {
      const grant = row.grant;
      const entry = "serverId" in grant ? null : allowEntryOf(grant);
      const granted = await ("serverId" in grant ? grantTool(row.agentId, grant, userId) : entry ? grantAllowEntry(this.hub, row.agentId, entry, userId) : Promise.resolve(false)).catch((error) => (log("approval_grant_error", { approvalId: id, error: String(error) }), false));
      log("approval_grant", { approvalId: id, agentId: row.agentId, granted });
    }
    await this.closed(row, approved, note);
    return true;
  }

  async settleUnanswered(now = Date.now()) {
    const db = getDb();
    const due = await db
      .select({ approval: schema.approvals, policy: schema.agents.approvalPolicy, trigger: schema.runs.trigger })
      .from(schema.approvals)
      .innerJoin(schema.agents, eq(schema.agents.id, schema.approvals.agentId))
      .leftJoin(schema.runs, eq(schema.runs.id, schema.approvals.runId))
      .where(
        and(
          eq(schema.approvals.status, "pending"),
          lte(schema.approvals.createdAt, new Date(now - UNANSWERED_AFTER_MS)),
          or(isNull(schema.approvals.expiresAt), gt(schema.approvals.expiresAt, new Date(now))),
          sql`${schema.agents.approvalPolicy}->>'fallback' in ('deny', 'allow')`,
        ),
      )
      .limit(100);
    const minutes = UNANSWERED_AFTER_MS / 60_000;
    for (const { approval, policy, trigger } of due) {
      const outcome = unansweredOutcome({ fallback: cleanApprovalPolicy(policy).fallback, askedBy: approval.askedBy, runTrigger: trigger });
      if (!outcome) continue;
      const approved = outcome === "allow";
      const note = brainText.unanswered(approved, minutes);
      const [row] = await db
        .update(schema.approvals)
        .set({ status: approved ? "approved" : "denied", note, answeredAt: new Date(now), answeredVia: "fallback" })
        .where(and(eq(schema.approvals.id, approval.id), eq(schema.approvals.status, "pending")))
        .returning();
      if (!row) continue;
      log("approval_unanswered", { approvalId: row.id, agentId: row.agentId, outcome });
      await this.hub.addMessage(row.agentId, "system", copy.approvalModes.unanswered(row.summary, approved, minutes), row.runId).catch((error) => log("approval_unanswered_note_error", { approvalId: row.id, error: String(error) }));
      await this.closed(row, approved, note);
    }
  }

  private async closed(row: typeof schema.approvals.$inferSelect, approved: boolean, note: string | undefined) {
    const db = getDb();
    const id = row.id;
    const status = approved ? "approved" : "denied";
    this.settle(id, { approved, note, status });
    await this.leaveChannelLists(row.agentId, id);
    if (row.source === "computer") {
      this.hub.sendToComputer(row.agentId, { type: "approval_answer", requestId: row.requestId ?? id, approved, note });
    }
    const pending = await db
      .select({ id: schema.approvals.id })
      .from(schema.approvals)
      .where(and(eq(schema.approvals.agentId, row.agentId), eq(schema.approvals.status, "pending")));
    if (pending.length === 0) {
      await db
        .update(schema.agents)
        .set({ state: "working", stateNote: null, updatedAt: new Date() })
        .where(and(eq(schema.agents.id, row.agentId), eq(schema.agents.state, "waiting_you")));
      this.hub.broadcast(row.agentId, { type: "state", state: "working", note: null });
    }
    this.hub.broadcast(row.agentId, { type: "approval_closed", id, status });
    if (row.askedBy) await this.hub.rooms.approvalClosed(id, status);
    await this.closeOnSlack(row);
  }

  async pendingFor(agentIds: string[]) {
    if (agentIds.length === 0) return [];
    return getDb()
      .select()
      .from(schema.approvals)
      .where(and(inArray(schema.approvals.agentId, agentIds), eq(schema.approvals.status, "pending")))
      .orderBy(desc(schema.approvals.createdAt));
  }

  private async notify(agentId: string, approval: ApprovalView, askedBy: string | null, guest = false) {
    const db = getDb();
    const [owner] = await db
      .select({ id: schema.user.id, email: schema.user.email, name: schema.agents.name })
      .from(schema.agents)
      .innerJoin(schema.user, eq(schema.user.id, schema.agents.ownerId))
      .where(eq(schema.agents.id, agentId));
    if (askedBy && askedBy !== owner?.id) return this.notifyAsker(agentId, approval, askedBy);
    if (!owner) return;
    const approvers = askedBy ? [] : await db
      .select({ id: schema.user.id, email: schema.user.email })
      .from(schema.agentMembers)
      .innerJoin(schema.user, eq(schema.user.id, schema.agentMembers.userId))
      .where(and(eq(schema.agentMembers.agentId, agentId), eq(schema.agentMembers.role, "approver")));
    sendPush([owner.id, ...approvers.map((a) => a.id)], {
      title: copy.push.approvalTitle(owner.name),
      body: approval.summary.slice(0, 180),
      url: "/waiting",
      tag: `approval-${approval.id}`,
    }).catch((error) => log("push_error", { error: String(error) }));
    const posted = guest ? null : await notifyApprovalOnChannel(this.hub, agentId, approval).catch((error) => (log("approval_channel_error", { error: String(error) }), null));
    const { text, blocks } = await slackApprovalMessage(owner.name, approval);
    const as = agentIdentity({ id: agentId, name: owner.name });
    const recipients = posted === "slack" ? approvers : [owner, ...approvers];
    for (const person of recipients) await rememberApprovalMessage(approval.id, await sendDirectMessage(person, text, blocks, as));
  }

  private async notifyAsker(agentId: string, approval: ApprovalView, askedBy: string) {
    const [person] = await getDb()
      .select({ id: schema.user.id, email: schema.user.email, name: schema.agents.name })
      .from(schema.agents)
      .innerJoin(schema.user, eq(schema.user.id, askedBy))
      .where(eq(schema.agents.id, agentId));
    if (!person) return;
    sendPush([person.id], {
      title: copy.push.approvalTitle(person.name),
      body: approval.summary.slice(0, 180),
      url: `/agents/${agentId}`,
      tag: `approval-${approval.id}`,
    }).catch((error) => log("push_error", { error: String(error) }));
    const { text, blocks } = await slackApprovalMessage(person.name, { ...approval, alwaysAllow: undefined });
    await rememberApprovalMessage(approval.id, await sendDirectMessage(person, text, blocks, agentIdentity({ id: agentId, name: person.name })));
  }

  async notifyOwner(agentId: string, text: string) {
    const [owner] = await getDb()
      .select({ id: schema.user.id, email: schema.user.email, name: schema.agents.name, teamId: schema.agents.teamId })
      .from(schema.agents)
      .innerJoin(schema.user, eq(schema.user.id, schema.agents.ownerId))
      .where(eq(schema.agents.id, agentId));
    if (!owner) return { slack: false, error: "no_owner" };
    await this.hub.addMessage(agentId, "agent", text, null, undefined, undefined, undefined, undefined, undefined, undefined, owner.teamId ? owner.id : null);
    const result = await sendDirectMessage(owner, escapeSlack(text), undefined, agentIdentity({ id: agentId, name: owner.name }));
    return result.ok ? { slack: true } : { slack: false, error: result.error ?? "unknown" };
  }
}
