import { and, count, desc, eq } from "drizzle-orm";
import type { Attachment } from "@understudy/protocol";
import { getDb, schema } from "@/lib/db";
import type { HeldMessage } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { messages as copy } from "@/lib/messages";
import type { Hub } from "../../hub";
import { parseSenderList } from "../../inbound-email/policy";
import type { ParsedAttachment, ParsedEmail } from "../../inbound-email/parse";
import { sendPush } from "../../push";
import { RateLimiter } from "../../rate-limit";
import { setRoute, type AddressedChannel, type ChannelThread } from "../store";
import { stripQuoted } from "./address";

export const MAX_HELD_PER_CHANNEL = 50;
export const MAX_HELD_ATTACHMENT_BYTES = 8 * 1024 * 1024;

const limiter = new RateLimiter();

export type SenderKind = "owner" | "allowed" | "unknown";

export function classifySender(from: string | null, allowedSenders: string | null, ownerEmail: string): SenderKind {
  if (!from || !from.includes("@")) return "unknown";
  const address = from.trim().toLowerCase();
  if (address === ownerEmail.trim().toLowerCase()) return "owner";
  const domain = address.split("@").pop() as string;
  const rules = parseSenderList(allowedSenders);
  return rules.some((rule) => (rule.includes("@") ? rule === address : rule === domain)) ? "allowed" : "unknown";
}

function stamp(now: number) {
  return new Date(now).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
}

async function findThread(channelId: string, peer: string, email: ParsedEmail): Promise<ChannelThread | null> {
  const known = new Set([...(email.inReplyTo ? [email.inReplyTo] : []), ...email.references]);
  if (!known.size) return null;
  const threads = await getDb()
    .select()
    .from(schema.channelThreads)
    .where(and(eq(schema.channelThreads.channelId, channelId), eq(schema.channelThreads.peer, peer), eq(schema.channelThreads.status, "open")))
    .orderBy(desc(schema.channelThreads.updatedAt))
    .limit(50);
  return threads.find((thread) => [thread.lastMessageId, ...thread.references.split(/\s+/)].some((id) => id && known.has(id))) ?? null;
}

function threadReferences(email: ParsedEmail, previous = "") {
  const ids = [...previous.split(/\s+/), ...email.references, ...(email.messageId ? [email.messageId] : [])].filter(Boolean);
  return [...new Set(ids)].slice(-20).join(" ");
}

export async function deliverToAgent(
  hub: Hub,
  input: { agentId: string; owner: AddressedChannel["owner"]; thread: ChannelThread; trusted: boolean; subject: string; text: string; attachments: ParsedAttachment[]; isNew: boolean },
  now = Date.now(),
) {
  const files: Attachment[] = [];
  for (const attachment of input.attachments) {
    const path = `email/${stamp(now)}-${attachment.filename}`;
    await hub.deliver(input.agentId, { type: "file_put", path, base64: attachment.base64 }, { source: "email" });
    files.push({ path: `inbox/${path}`, name: attachment.filename, size: attachment.bytes, mime: attachment.mimeType || "application/octet-stream" });
  }
  const body = stripQuoted(input.text).slice(0, 8000);
  const said = input.isNew && input.subject ? `${input.subject}\n\n${body}` : body;
  const shown = input.trusted ? said : copy.channels.fromPeer(input.thread.peerName ? `${input.thread.peerName} <${input.thread.peer}>` : input.thread.peer, said);
  await hub.addMessage(input.agentId, "user", shown, null, input.trusted ? input.owner.id : undefined, "email", undefined, files.length ? files : undefined);
  await setRoute(input.agentId, input.thread.id, new Date(now));
  const message = {
    type: "chat" as const,
    text: said,
    from: input.trusted ? input.owner.name : input.thread.peer,
    ...(input.trusted ? {} : { external: { channel: "email", sender: input.thread.peer } }),
    ...(files.length ? { attachments: files } : {}),
  };
  return hub.deliver(input.agentId, message, { source: "email", channelThreadId: input.thread.id });
}

function heldCopy(email: ParsedEmail): HeldMessage {
  const attachments: ParsedAttachment[] = [];
  let total = 0;
  for (const attachment of email.attachments) {
    if (total + attachment.bytes > MAX_HELD_ATTACHMENT_BYTES) continue;
    total += attachment.bytes;
    attachments.push(attachment);
  }
  return { subject: email.subject, text: email.text, date: email.date, attachments, droppedAttachments: email.attachments.length - attachments.length };
}

export async function receiveChannelEmail(hub: Hub, addressed: AddressedChannel, email: ParsedEmail, problem: string | null, now = Date.now()) {
  const { channel, owner } = addressed;
  if (problem) return problem;
  if (email.automated) return "automated";
  const sender = classifySender(email.from, channel.allowedSenders, owner.email);
  const peer = (email.from ?? "").trim().toLowerCase();
  if (sender === "unknown" && channel.unknownSenders === "ignore") return "sender_not_allowed";
  if (!limiter.allow(`channel-email:${channel.id}`, 0.2, 10) || !limiter.allow(`channel-email-peer:${channel.id}:${peer}`, 0.05, 5)) return "too_many_emails";
  const db = getDb();
  if (sender === "unknown") {
    const [{ held }] = await db
      .select({ held: count() })
      .from(schema.channelThreads)
      .where(and(eq(schema.channelThreads.channelId, channel.id), eq(schema.channelThreads.status, "held")));
    if (held >= MAX_HELD_PER_CHANNEL) return "held_full";
    await db.insert(schema.channelThreads).values({
      id: newId("cth"),
      agentId: channel.agentId,
      channelId: channel.id,
      peer,
      peerName: email.fromName,
      trusted: false,
      status: "held",
      subject: email.subject,
      lastMessageId: email.messageId,
      references: threadReferences(email),
      held: heldCopy(email),
    });
    await hub.addMessage(channel.agentId, "system", copy.channels.held(peer));
    sendPush([owner.id], { title: copy.channels.heldPush(addressed.agentName), body: peer, url: `/agents/${channel.agentId}?tab=settings`, tag: `held-${channel.id}` }).catch(() => undefined);
    return "held";
  }
  const existing = await findThread(channel.id, peer, email);
  const thread =
    existing ??
    (
      await db
        .insert(schema.channelThreads)
        .values({ id: newId("cth"), agentId: channel.agentId, channelId: channel.id, peer, peerName: email.fromName, trusted: sender === "owner", subject: email.subject })
        .returning()
    )[0];
  const [updated] = await db
    .update(schema.channelThreads)
    .set({ lastMessageId: email.messageId ?? thread.lastMessageId, references: threadReferences(email, thread.references), peerName: email.fromName ?? thread.peerName, updatedAt: new Date(now) })
    .where(eq(schema.channelThreads.id, thread.id))
    .returning();
  const result = await deliverToAgent(hub, { agentId: channel.agentId, owner, thread: updated, trusted: sender === "owner", subject: email.subject, text: email.text, attachments: email.attachments, isNew: !existing }, now);
  return result.status === "sent" ? "delivered" : "queued";
}
