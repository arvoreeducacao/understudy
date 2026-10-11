import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import type { Hub } from "../hub";
import { readApprovalLinkToken } from "./approval-link";

export type LinkedApproval = {
  id: string;
  agentName: string;
  ownerId: string;
  summary: string;
  fields: { label: string; value: string }[];
  status: string;
};

export async function approvalForLink(token: string, now = Date.now()): Promise<LinkedApproval | null> {
  const id = readApprovalLinkToken(token, now);
  if (!id) return null;
  const [row] = await getDb()
    .select({ id: schema.approvals.id, summary: schema.approvals.summary, fields: schema.approvals.fields, status: schema.approvals.status, agentName: schema.agents.name, ownerId: schema.agents.ownerId })
    .from(schema.approvals)
    .innerJoin(schema.agents, eq(schema.agents.id, schema.approvals.agentId))
    .where(eq(schema.approvals.id, id));
  return row ?? null;
}

export async function answerByLink(hub: Hub | null, token: string, approved: boolean, note: string | undefined, now = Date.now()) {
  const approval = await approvalForLink(token, now);
  if (!approval) return { ok: false as const, status: null };
  const clean = note?.trim().slice(0, 2000) || undefined;
  let ok = false;
  if (hub) ok = await hub.answerApproval(approval.id, approved, clean, approval.ownerId);
  else {
    const updated = await getDb()
      .update(schema.approvals)
      .set({ status: approved ? "approved" : "denied", note: clean ?? null, answeredBy: approval.ownerId, answeredAt: new Date() })
      .where(and(eq(schema.approvals.id, approval.id), eq(schema.approvals.status, "pending")))
      .returning({ id: schema.approvals.id });
    ok = updated.length > 0;
  }
  const [current] = await getDb().select({ status: schema.approvals.status }).from(schema.approvals).where(eq(schema.approvals.id, approval.id));
  return { ok, status: current?.status ?? null };
}
