import { eq } from "drizzle-orm";
import type { Attachment } from "@understudy/protocol";
import { getDb, schema } from "@/lib/db";
import type { ChannelKind } from "@/lib/db/schema";
import { messages as copy } from "@/lib/messages";
import type { Hub } from "../hub";
import type { ChannelAdapter } from "./adapter";
import { emailAdapter } from "./email/adapter";
import { activeRoute, appendPending, pendingThreads, stalePendingThreads, takePending, type ActiveRoute } from "./store";

export const STALE_PENDING_MS = 90 * 1000;

const adapters = new Map<ChannelKind, ChannelAdapter>([["email", emailAdapter()]]);

export function registerAdapter(adapter: ChannelAdapter) {
  adapters.set(adapter.kind, adapter);
}

export function channelAdapter(kind: ChannelKind) {
  return adapters.get(kind) ?? null;
}

function log(event: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
}

export function routeWins(route: ActiveRoute | null, slack: { updatedAt: Date } | null) {
  if (!route) return null;
  return !slack || route.updatedAt.getTime() >= slack.updatedAt.getTime() ? route : null;
}

export async function queueReplyText(route: ActiveRoute, text: string) {
  await appendPending(route.threadId, { text });
}

export async function queueReplyFile(agentId: string, attachment: Attachment) {
  const route = await activeRoute(agentId);
  if (!route) return false;
  await appendPending(route.threadId, { file: attachment });
  return true;
}

const flushing = new Map<string, Promise<void>>();

async function sendThread(hub: Hub, agentId: string, threadId: string) {
  const taken = await takePending(threadId);
  if (!taken || (!taken.text.trim() && !taken.files.length)) return;
  const adapter = channelAdapter(taken.channel.kind);
  const [agent] = await getDb().select({ name: schema.agents.name }).from(schema.agents).where(eq(schema.agents.id, agentId));
  try {
    if (!adapter) throw new Error(`no adapter for ${taken.channel.kind}`);
    await adapter.send(hub, { agentId, agentName: agent?.name ?? "", channel: taken.channel, thread: taken.thread, reply: { text: taken.text, files: taken.files } });
    log("channel_reply_sent", { agentId, kind: taken.channel.kind, files: taken.files.length });
  } catch (error) {
    log("channel_reply_failed", { agentId, kind: taken.channel.kind, error: String(error).slice(0, 300) });
    await hub.addMessage(agentId, "system", copy.channels.replyFailed(taken.channel.kind, taken.thread.peer));
  }
}

export function flushReplies(hub: Hub, agentId: string) {
  const previous = flushing.get(agentId) ?? Promise.resolve();
  const next = previous
    .then(async () => {
      for (const threadId of await pendingThreads(agentId)) await sendThread(hub, agentId, threadId);
    })
    .catch((error) => log("channel_flush_error", { agentId, error: String(error) }))
    .finally(() => {
      if (flushing.get(agentId) === next) flushing.delete(agentId);
    });
  flushing.set(agentId, next);
  return next;
}

export async function flushStale(hub: Hub, now = Date.now()) {
  const stale = await stalePendingThreads(new Date(now - STALE_PENDING_MS));
  for (const agentId of new Set(stale.map((row) => row.agentId))) await flushReplies(hub, agentId);
}
