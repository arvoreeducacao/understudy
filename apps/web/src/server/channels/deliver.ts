import { and, count, desc, eq } from "drizzle-orm";
import type { Attachment } from "@understudy/protocol";
import { getDb, schema } from "@/lib/db";
import type { ChannelKind, HeldMessage } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { messages as copy } from "@/lib/messages";
import type { Hub } from "../hub";
import type { ParsedAttachment } from "../inbound-email/parse";
import { sendPush } from "../push";
import { ownerAudience } from "../teams-store";
import { setRoute, type AddressedChannel, type ChannelThread } from "./store";

export const MAX_HELD_PER_CHANNEL = 50;
export const MAX_HELD_ATTACHMENT_BYTES = 8 * 1024 * 1024;

function stamp(now: number) {
  return new Date(now).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
}

export function senderLabel(thread: Pick<ChannelThread, "peer" | "peerName">) {
  return (thread.peerName ?? thread.peer).slice(0, 160);
}

export async function deliverToAgent(
  hub: Hub,
  input: { kind: ChannelKind; agentId: string; owner: AddressedChannel["owner"]; thread: ChannelThread; trusted: boolean; text: string; attachments: ParsedAttachment[] },
  now = Date.now(),
) {
  const files: Attachment[] = [];
  for (const attachment of input.attachments) {
    const path = `${input.kind}/${stamp(now)}-${attachment.filename}`;
    await hub.deliver(input.agentId, { type: "file_put", path, base64: attachment.base64 }, { source: "channel" });
    files.push({ path: `inbox/${path}`, name: attachment.filename, size: attachment.bytes, mime: attachment.mimeType || "application/octet-stream" });
  }
  const said = input.text.slice(0, 8000);
  const who = input.thread.peerName ? `${input.thread.peerName} (${input.thread.peer})` : input.thread.peer;
  const audience = await ownerAudience(input.agentId);
  await hub.addMessage(input.agentId, "user", said, null, input.trusted ? input.owner.id : undefined, input.kind, undefined, files.length ? files : undefined, undefined, input.trusted ? undefined : senderLabel(input.thread), audience);
  const message = {
    type: "chat" as const,
    text: said,
    from: input.trusted ? input.owner.name : input.thread.peer,
    ...(audience ? { askedBy: audience } : {}),
    ...(input.trusted ? {} : { external: { channel: input.kind, sender: who } }),
    origin: input.thread.id,
    ...(files.length ? { attachments: files } : {}),
  };
  const result = await hub.deliver(input.agentId, message, { source: "channel", channelThreadId: input.thread.id });
  if (result.status === "sent" && input.trusted) await setRoute(input.agentId, input.thread.id, new Date(now));
  return result;
}

export function heldCopy(input: { subject: string; text: string; date: string | null; attachments: ParsedAttachment[] }): HeldMessage {
  const attachments: ParsedAttachment[] = [];
  let total = 0;
  for (const attachment of input.attachments) {
    if (total + attachment.bytes > MAX_HELD_ATTACHMENT_BYTES) continue;
    total += attachment.bytes;
    attachments.push(attachment);
  }
  return { subject: input.subject, text: input.text, date: input.date, attachments, droppedAttachments: input.attachments.length - attachments.length };
}

export async function holdMessage(
  hub: Hub,
  addressed: AddressedChannel,
  input: { peer: string; peerName: string | null; held: HeldMessage; lastMessageId?: string | null; references?: string; settings?: Record<string, unknown> },
) {
  const { channel, owner } = addressed;
  const db = getDb();
  const [{ held }] = await db
    .select({ held: count() })
    .from(schema.channelThreads)
    .where(and(eq(schema.channelThreads.channelId, channel.id), eq(schema.channelThreads.status, "held")));
  if (held >= MAX_HELD_PER_CHANNEL) return "held_full";
  await db.insert(schema.channelThreads).values({
    id: newId("cth"),
    agentId: channel.agentId,
    channelId: channel.id,
    peer: input.peer,
    peerName: input.peerName,
    trusted: false,
    status: "held",
    subject: input.held.subject,
    lastMessageId: input.lastMessageId ?? null,
    references: input.references ?? "",
    held: input.held,
  });
  const who = input.peerName ? `${input.peerName} (${input.peer})` : input.peer;
  await hub.addMessage(channel.agentId, "system", copy.channels.held(copy.channels.kinds[channel.kind] ?? channel.kind, who), null, undefined, undefined, undefined, undefined, undefined, undefined, await ownerAudience(channel.agentId));
  sendPush([owner.id], { title: copy.channels.heldPush(addressed.agentName, copy.channels.kinds[channel.kind] ?? channel.kind), body: who, url: `/agents/${channel.agentId}?tab=settings`, tag: `held-${channel.id}` }).catch(() => undefined);
  return "held";
}

export async function openPeerThread(addressed: AddressedChannel, input: { peer: string; peerName: string | null; trusted: boolean; messageId: string }, now = Date.now()): Promise<ChannelThread> {
  const db = getDb();
  const [existing] = await db
    .select()
    .from(schema.channelThreads)
    .where(and(eq(schema.channelThreads.channelId, addressed.channel.id), eq(schema.channelThreads.peer, input.peer), eq(schema.channelThreads.status, "open")))
    .orderBy(desc(schema.channelThreads.updatedAt))
    .limit(1);
  if (existing) {
    const [updated] = await db
      .update(schema.channelThreads)
      .set({ lastMessageId: input.messageId, peerName: input.peerName ?? existing.peerName, trusted: input.trusted, updatedAt: new Date(now) })
      .where(eq(schema.channelThreads.id, existing.id))
      .returning();
    return updated;
  }
  const [created] = await db
    .insert(schema.channelThreads)
    .values({ id: newId("cth"), agentId: addressed.channel.agentId, channelId: addressed.channel.id, peer: input.peer, peerName: input.peerName, trusted: input.trusted, lastMessageId: input.messageId })
    .returning();
  return created;
}
