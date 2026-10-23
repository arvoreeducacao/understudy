import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import type { SlackMessageRef } from "@/lib/db/schema";
import { messages as copy } from "@/lib/messages";
import { escapeSlack, slackCall } from "./slack";

type ApprovalRow = typeof schema.approvals.$inferSelect;

function log(event: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
}

export async function rememberApprovalMessage(approvalId: string, posted: { ok: boolean; channel?: unknown; ts?: unknown }) {
  if (!posted.ok || typeof posted.channel !== "string" || typeof posted.ts !== "string") return;
  const ref: SlackMessageRef = { channel: posted.channel, ts: posted.ts };
  const [row] = await getDb()
    .update(schema.approvals)
    .set({ slackMessages: sql`coalesce(${schema.approvals.slackMessages}, '[]'::jsonb) || ${JSON.stringify([ref])}::jsonb` })
    .where(eq(schema.approvals.id, approvalId))
    .returning();
  if (row && row.status !== "pending") await closeApprovalOnSlack(row, [ref]);
}

export function approvalClosedLine(row: Pick<ApprovalRow, "status" | "answeredVia" | "answeredAt">, who: string) {
  const closed = copy.slackApp.approvalClosed;
  const via = closed.via[row.answeredVia ?? "panel"] ?? closed.via.panel;
  const base = row.status === "approved" ? closed.approved(who, via) : row.status === "denied" ? closed.denied(who, via) : row.status === "expired" ? closed.expired : closed.cancelled;
  const at = row.answeredAt ?? new Date();
  const fallback = `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")} UTC`;
  return { plain: base, timed: `${base} · <!date^${Math.floor(at.getTime() / 1000)}^{time}|${fallback}>` };
}

export async function closeApprovalOnSlack(row: ApprovalRow, refs: SlackMessageRef[] = row.slackMessages ?? []) {
  if (!refs.length || row.status === "pending") return;
  const [person] = row.answeredBy ? await getDb().select({ name: schema.user.name }).from(schema.user).where(eq(schema.user.id, row.answeredBy)) : [];
  const line = approvalClosedLine(row, escapeSlack(person?.name ?? ""));
  const summary = escapeSlack(row.summary);
  const blocks = [
    { type: "section", text: { type: "mrkdwn", text: summary } },
    { type: "context", elements: [{ type: "mrkdwn", text: line.timed }] },
  ];
  for (const ref of refs) {
    const result = await slackCall("chat.update", { channel: ref.channel, ts: ref.ts, text: `${line.plain}: ${summary}`, blocks });
    if (!result.ok) log("slack_approval_update_failed", { approvalId: row.id, error: result.error });
  }
}
