import { eq } from "drizzle-orm";
import type { Attachment } from "@understudy/protocol";
import { getDb, schema } from "@/lib/db";
import type { ChannelKind } from "@/lib/db/schema";
import { messages as copy } from "@/lib/messages";
import type { Hub } from "../hub";
import type { ChannelAdapter } from "./adapter";
import { slackAdapter } from "./slack/adapter";
import { telegramAdapter } from "./telegram/adapter";
import { activeRoute, appendPending, pendingThreads, stalePendingThreads, takePending, type ActiveRoute } from "./store";

export const STALE_PENDING_MS = 90 * 1000;

const adapters = new Map<ChannelKind, ChannelAdapter>([
  ["slack", slackAdapter()],
  ["telegram", telegramAdapter()],
]);

export function registerAdapter(adapter: ChannelAdapter) {
  adapters.set(adapter.kind, adapter);
}

export function channelAdapter(kind: ChannelKind) {
  return adapters.get(kind) ?? null;
}

function log(event: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
}

export type Conversation = { kind: ChannelKind; adapter: ChannelAdapter; since: Date; route: ActiveRoute | null };

function live() {
  return [...adapters.values()].filter((adapter) => adapter.live);
}

export async function currentConversation(agentId: string): Promise<Conversation | null> {
  const candidates: Conversation[] = [];
  const route = await activeRoute(agentId);
  const routed = route ? adapters.get(route.kind) : undefined;
  if (route && routed) candidates.push({ kind: route.kind, adapter: routed, since: route.updatedAt, route });
  for (const adapter of live()) {
    const since = await adapter.live?.activeSince(agentId);
    if (since) candidates.push({ kind: adapter.kind, adapter, since, route: null });
  }
  return candidates.reduce<Conversation | null>((best, next) => (!best || next.since.getTime() > best.since.getTime() ? next : best), null);
}

export async function relayReply(conversation: Conversation, agentId: string, text: string, streamId?: string) {
  if (conversation.route) return queueReplyText(conversation.route, text);
  await conversation.adapter.live?.say(agentId, text, streamId);
}

export async function relayDelta(agentId: string, streamId: string, text: string) {
  for (const adapter of live()) await adapter.live?.delta?.(agentId, streamId, text);
}

export async function relayActivityText(agentId: string, text: string) {
  const conversation = await currentConversation(agentId);
  if (conversation && !conversation.route) await conversation.adapter.live?.activity?.(agentId, text);
}

export async function relayPanelMessage(agentId: string, author: string, text: string) {
  for (const adapter of live()) await adapter.live?.panelSaid?.(agentId, author, text);
}

export async function relayRunStarted(agentId: string, runId: string, title: string, steps: string[]) {
  for (const adapter of live()) await adapter.live?.runStarted?.(agentId, runId, title, steps);
}

export async function relayRunFinished(agentId: string, runId: string, title: string, steps: string[], ok: boolean, summary: string) {
  for (const adapter of live()) await adapter.live?.runFinished?.(agentId, runId, title, steps, ok, summary);
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
    if (!adapter?.send) throw new Error(`no adapter for ${taken.channel.kind}`);
    await adapter.send(hub, { agentId, agentName: agent?.name ?? "", channel: taken.channel, thread: taken.thread, reply: { text: taken.text, files: taken.files } });
    log("channel_reply_sent", { agentId, kind: taken.channel.kind, files: taken.files.length });
  } catch (error) {
    log("channel_reply_failed", { agentId, kind: taken.channel.kind, error: String(error).slice(0, 300) });
    await hub.addMessage(agentId, "system", copy.channels.replyFailed(copy.channels.kinds[taken.channel.kind] ?? taken.channel.kind, taken.thread.peerName ?? taken.thread.peer));
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
