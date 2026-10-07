import { and, desc, eq, inArray, lt } from "drizzle-orm";
import type { ApprovalRequest } from "@understudy/protocol";
import { brainText } from "@/lib/brain-text";
import { getDb, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { newId } from "@/lib/ids";
import { messages as copy } from "@/lib/messages";
import type { Hub } from "../hub";
import { sendPush } from "../push";
import { postApprovalInThread } from "../slack-threads";
import type { ApprovalView } from "../hub-types";
import { isOffRecipe } from "@/lib/approval-fields";
import { agentIdentity, escapeSlack, sendDirectMessage, slackInteractive } from "../slack";
import { log, type Answer } from "./shared";

export class Approvals {
  private waiters = new Map<string, Set<(answer: Answer) => void>>();

  constructor(private hub: Hub) {}

  async create(
    agentId: string,
    request: Partial<ApprovalRequest> & { summary: string },
    source: "mcp" | "computer",
    timeoutSeconds?: number,
    payloadHash?: string,
  ) {
    const db = getDb();
    const id = newId("apr");
    const requestId = source === "computer" && request.id ? request.id : null;
    const expiresAt = timeoutSeconds ? new Date(Date.now() + timeoutSeconds * 1000) : null;
    const row = {
      id,
      agentId,
      runId: request.runId || null,
      stepId: request.stepId ?? null,
      summary: request.summary,
      fields: request.fields ?? [],
      source,
      requestId,
      payloadHash: payloadHash ?? null,
      expiresAt,
    };
    await db.insert(schema.approvals).values(row);
    await db
      .update(schema.agents)
      .set({ state: "waiting_you", stateNote: request.summary, updatedAt: new Date() })
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
    };
    this.hub.broadcast(agentId, { type: "approval", approval: view });
    this.hub.broadcast(agentId, { type: "state", state: "waiting_you", note: request.summary });
    log("approval_created", { agentId, approvalId: id, source });
    this.notify(agentId, view).catch((error) => log("approval_notify_error", { error: String(error) }));
    return id;
  }

  async payloadHash(id: string, agentId: string) {
    const [row] = await getDb()
      .select({ hash: schema.approvals.payloadHash, status: schema.approvals.status })
      .from(schema.approvals)
      .where(and(eq(schema.approvals.id, id), eq(schema.approvals.agentId, agentId)));
    return row?.status === "approved" ? row.hash : null;
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
      if (row.source === "computer") {
        this.hub.sendToComputer(row.agentId, {
          type: "approval_answer",
          requestId: row.requestId ?? row.id,
          approved: false,
          note: brainText.expiredNote,
        });
      }
      this.hub.broadcast(row.agentId, { type: "approval_closed", id: row.id, status: "expired" });
    }
  }

  async answer(id: string, approved: boolean, note: string | undefined, userId: string) {
    const db = getDb();
    const status = approved ? "approved" : "denied";
    const [row] = await db
      .update(schema.approvals)
      .set({ status, note: note ?? null, answeredBy: userId, answeredAt: new Date() })
      .where(and(eq(schema.approvals.id, id), eq(schema.approvals.status, "pending")))
      .returning();
    if (!row) return false;
    log("approval_answered", { approvalId: id, agentId: row.agentId, status });
    this.settle(id, { approved, note, status });
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
    return true;
  }

  async pendingFor(agentIds: string[]) {
    if (agentIds.length === 0) return [];
    return getDb()
      .select()
      .from(schema.approvals)
      .where(and(inArray(schema.approvals.agentId, agentIds), eq(schema.approvals.status, "pending")))
      .orderBy(desc(schema.approvals.createdAt));
  }

  private async notify(agentId: string, approval: ApprovalView) {
    const db = getDb();
    const [owner] = await db
      .select({ id: schema.user.id, email: schema.user.email, name: schema.agents.name })
      .from(schema.agents)
      .innerJoin(schema.user, eq(schema.user.id, schema.agents.ownerId))
      .where(eq(schema.agents.id, agentId));
    if (!owner) return;
    const link = `${env.publicUrl}/waiting`;
    const fieldsText = approval.fields.map((f) => `*${escapeSlack(f.label)}:* ${f.value.trim() ? escapeSlack(f.value) : `_${copy.approvals.emptyValue}_`}`).join("\n");
    const fields = fieldsText.length > 2800 ? `${fieldsText.slice(0, 2800)}…\n${copy.slack.fullInPanel}` : fieldsText;
    const text = copy.slack.approvalText(escapeSlack(owner.name), escapeSlack(approval.summary));
    const interactive = await slackInteractive();
    const blocks = [
      ...(isOffRecipe(approval.fields) ? [{ type: "section", text: { type: "mrkdwn", text: `:warning: ${copy.approvals.offRecipe}` } }] : []),
      { type: "section", text: { type: "mrkdwn", text } },
      ...(fields ? [{ type: "section", text: { type: "mrkdwn", text: fields } }] : []),
      {
        type: "actions",
        elements: [
          ...(interactive
            ? [
                { type: "button", action_id: "approve", text: { type: "plain_text", text: copy.approvals.approve }, value: approval.id, style: "primary" },
                { type: "button", action_id: "deny", text: { type: "plain_text", text: copy.approvals.deny }, value: approval.id, style: "danger" },
              ]
            : []),
          { type: "button", action_id: "open", text: { type: "plain_text", text: copy.slack.openPanel }, url: link, ...(interactive ? {} : { style: "primary" }) },
        ],
      },
    ];
    const approvers = await db
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
    const as = agentIdentity({ id: agentId, name: owner.name });
    const inThread = await postApprovalInThread(agentId, blocks, text).catch(() => false);
    const recipients = inThread ? approvers : [owner, ...approvers];
    for (const person of recipients) await sendDirectMessage(person, text, blocks, as);
  }

  async notifyOwner(agentId: string, text: string) {
    const [owner] = await getDb()
      .select({ id: schema.user.id, email: schema.user.email, name: schema.agents.name })
      .from(schema.agents)
      .innerJoin(schema.user, eq(schema.user.id, schema.agents.ownerId))
      .where(eq(schema.agents.id, agentId));
    if (!owner) return { slack: false, error: "no_owner" };
    await this.hub.addMessage(agentId, "agent", text);
    const result = await sendDirectMessage(owner, escapeSlack(text), undefined, agentIdentity({ id: agentId, name: owner.name }));
    return result.ok ? { slack: true } : { slack: false, error: result.error ?? "unknown" };
  }
}
