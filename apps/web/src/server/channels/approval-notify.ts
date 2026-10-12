import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import type { Hub } from "../hub";
import type { ApprovalView } from "../hub-types";
import { channelAdapter, flushReplies } from "./relay";
import { activeRoute } from "./store";

function log(event: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
}

export async function notifyApprovalOnChannel(hub: Hub, agentId: string, approval: ApprovalView) {
  const route = await activeRoute(agentId);
  if (!route) return false;
  const adapter = channelAdapter(route.kind);
  if (!adapter?.sendApproval) return false;
  const [row] = await getDb()
    .select({ thread: schema.channelThreads, channel: schema.agentChannels, agentName: schema.agents.name, ownerId: schema.user.id, ownerEmail: schema.user.email, ownerName: schema.user.name })
    .from(schema.channelThreads)
    .innerJoin(schema.agentChannels, eq(schema.agentChannels.id, schema.channelThreads.channelId))
    .innerJoin(schema.agents, eq(schema.agents.id, schema.agentChannels.agentId))
    .innerJoin(schema.user, eq(schema.user.id, schema.agents.ownerId))
    .where(eq(schema.channelThreads.id, route.threadId));
  if (!row) return false;
  await flushReplies(hub, agentId);
  try {
    const sent = await adapter.sendApproval(hub, {
      agentId,
      agentName: row.agentName,
      channel: row.channel,
      routeThread: row.thread,
      owner: { id: row.ownerId, email: row.ownerEmail, name: row.ownerName },
      approval,
    });
    log("approval_sent_on_channel", { agentId, approvalId: approval.id, kind: route.kind, sent });
    return sent;
  } catch (error) {
    log("approval_channel_failed", { agentId, approvalId: approval.id, kind: route.kind, error: String(error).slice(0, 300) });
    return false;
  }
}
