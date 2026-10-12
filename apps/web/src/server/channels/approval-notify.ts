import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import type { ChannelKind } from "@/lib/db/schema";
import type { Hub } from "../hub";
import type { ApprovalView } from "../hub-types";
import { currentConversation, flushReplies, type Conversation } from "./relay";

function log(event: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
}

async function sendOnRoute(hub: Hub, agentId: string, approval: ApprovalView, conversation: Conversation) {
  const adapter = conversation.adapter;
  if (!conversation.route || !adapter.sendApproval) return false;
  const [row] = await getDb()
    .select({ thread: schema.channelThreads, channel: schema.agentChannels, agentName: schema.agents.name, ownerId: schema.user.id, ownerEmail: schema.user.email, ownerName: schema.user.name })
    .from(schema.channelThreads)
    .innerJoin(schema.agentChannels, eq(schema.agentChannels.id, schema.channelThreads.channelId))
    .innerJoin(schema.agents, eq(schema.agents.id, schema.agentChannels.agentId))
    .innerJoin(schema.user, eq(schema.user.id, schema.agents.ownerId))
    .where(eq(schema.channelThreads.id, conversation.route.threadId));
  if (!row) return false;
  await flushReplies(hub, agentId);
  return adapter.sendApproval(hub, { agentId, agentName: row.agentName, channel: row.channel, routeThread: row.thread, owner: { id: row.ownerId, email: row.ownerEmail, name: row.ownerName }, approval });
}

export async function notifyApprovalOnChannel(hub: Hub, agentId: string, approval: ApprovalView): Promise<ChannelKind | null> {
  const conversation = await currentConversation(agentId);
  if (!conversation) return null;
  try {
    const sent = conversation.route ? await sendOnRoute(hub, agentId, approval, conversation) : Boolean(await conversation.adapter.live?.approval?.(agentId, approval));
    log("approval_sent_on_channel", { agentId, approvalId: approval.id, kind: conversation.kind, sent });
    return sent ? conversation.kind : null;
  } catch (error) {
    log("approval_channel_failed", { agentId, approvalId: approval.id, kind: conversation.kind, error: String(error).slice(0, 300) });
    return null;
  }
}
