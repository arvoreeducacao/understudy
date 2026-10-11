import { and, desc, eq } from "drizzle-orm";
import { isOffRecipe } from "@/lib/approval-fields";
import { getDb, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { newId } from "@/lib/ids";
import { messages as copy } from "@/lib/messages";
import type { Hub } from "../hub";
import type { ApprovalView } from "../hub-types";
import { approvalLinkUrl } from "./approval-link";
import { channelAdapter, flushReplies } from "./relay";
import { activeRoute, type ChannelThread } from "./store";

const FIELD_CHARS = 500;
const FIELDS_CHARS = 4000;

function log(event: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
}

export function approvalEmailText(input: { agentName: string; approval: Pick<ApprovalView, "summary" | "fields">; link: string; waitingUrl: string }) {
  const fields = input.approval.fields
    .map((field) => `${field.label}: ${field.value.trim() ? field.value.trim().slice(0, FIELD_CHARS) : copy.approvals.emptyValue}`)
    .join("\n")
    .slice(0, FIELDS_CHARS);
  return [
    ...(isOffRecipe(input.approval.fields) ? [copy.approvals.offRecipe, ""] : []),
    copy.channels.approvalAsk(input.agentName),
    "",
    input.approval.summary,
    ...(fields ? ["", fields] : []),
    "",
    copy.channels.approvalLink(input.link),
    copy.channels.approvalPanel(input.waitingUrl),
  ].join("\n");
}

async function ownerThread(channelId: string, agentId: string, owner: { email: string; name: string }, summary: string): Promise<ChannelThread> {
  const db = getDb();
  const peer = owner.email.trim().toLowerCase();
  const [existing] = await db
    .select()
    .from(schema.channelThreads)
    .where(and(eq(schema.channelThreads.channelId, channelId), eq(schema.channelThreads.peer, peer), eq(schema.channelThreads.trusted, true), eq(schema.channelThreads.status, "open")))
    .orderBy(desc(schema.channelThreads.updatedAt))
    .limit(1);
  if (existing) return existing;
  const [created] = await db.insert(schema.channelThreads).values({ id: newId("cth"), agentId, channelId, peer, peerName: owner.name, trusted: true, subject: summary.slice(0, 200) }).returning();
  return created;
}

export async function emailApproval(hub: Hub, agentId: string, approval: ApprovalView) {
  const route = await activeRoute(agentId);
  if (!route || route.kind !== "email") return false;
  const adapter = channelAdapter("email");
  if (!adapter) return false;
  const db = getDb();
  const [row] = await db
    .select({ thread: schema.channelThreads, channel: schema.agentChannels, agentName: schema.agents.name, ownerEmail: schema.user.email, ownerName: schema.user.name })
    .from(schema.channelThreads)
    .innerJoin(schema.agentChannels, eq(schema.agentChannels.id, schema.channelThreads.channelId))
    .innerJoin(schema.agents, eq(schema.agents.id, schema.agentChannels.agentId))
    .innerJoin(schema.user, eq(schema.user.id, schema.agents.ownerId))
    .where(eq(schema.channelThreads.id, route.threadId));
  if (!row) return false;
  await flushReplies(hub, agentId);
  const thread = row.thread.trusted ? row.thread : await ownerThread(row.channel.id, agentId, { email: row.ownerEmail, name: row.ownerName }, approval.summary);
  const [fresh] = await db.select().from(schema.channelThreads).where(eq(schema.channelThreads.id, thread.id));
  const text = approvalEmailText({ agentName: row.agentName, approval, link: approvalLinkUrl(approval.id), waitingUrl: `${env.publicUrl}/waiting` });
  try {
    await adapter.send(hub, { agentId, agentName: row.agentName, channel: row.channel, thread: fresh ?? thread, reply: { text, files: [] } });
    log("approval_emailed", { agentId, approvalId: approval.id });
    return true;
  } catch (error) {
    log("approval_email_failed", { agentId, approvalId: approval.id, error: String(error).slice(0, 300) });
    return false;
  }
}
