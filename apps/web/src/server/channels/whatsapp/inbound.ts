import { FILE_MAX_BYTES } from "@understudy/protocol";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { messages as copy } from "@/lib/messages";
import type { Hub } from "../../hub";
import type { ParsedAttachment } from "../../inbound-email/parse";
import { RateLimiter } from "../../rate-limit";
import { deliverToAgent, heldCopy, holdMessage, openPeerThread } from "../deliver";
import { peerListed } from "../peers";
import { channelByAddress, dropFromChannelList, type AddressedChannel } from "../store";
import { isSelfChat, OWN_MESSAGE_PREFIX, parseApprovalReply, peerOf, type WaIdentity, type WaInbound } from "./message";

export const STALE_MS = 5 * 60 * 1000;
export const MAX_PENDING_APPROVALS = 10;

export type PendingApproval = { code: string; id: string };

export type WhatsAppContext = {
  channelId: string;
  me: WaIdentity;
  inbound: WaInbound;
  fetchMedia: ((maxBytes: number) => Promise<Buffer | null>) | null;
  reply: (text: string) => Promise<unknown>;
  now: number;
};

const limiter = new RateLimiter();

export function pendingApprovals(settings: Record<string, unknown>): PendingApproval[] {
  const list = settings.approvals;
  return Array.isArray(list) ? list.filter((item): item is PendingApproval => typeof item?.code === "string" && typeof item?.id === "string") : [];
}

async function attachmentOf(context: WhatsAppContext): Promise<ParsedAttachment[]> {
  const media = context.inbound.media;
  if (!media || !context.fetchMedia || media.bytes > FILE_MAX_BYTES) return [];
  const data = await context.fetchMedia(FILE_MAX_BYTES).catch(() => null);
  if (!data || data.length > FILE_MAX_BYTES) return [];
  return [{ filename: media.filename, mimeType: media.mime, base64: data.toString("base64"), bytes: data.length }];
}

async function answerFromChat(hub: Hub, addressed: AddressedChannel, context: WhatsAppContext) {
  const reply = parseApprovalReply(context.inbound.text);
  const pending = pendingApprovals(addressed.channel.settings);
  if (!reply || !pending.length) return null;
  if (!reply.code && pending.length > 1) {
    await context.reply(copy.channels.whatsappWhichOne(pending.map((item) => item.code)));
    return "needs_code";
  }
  const target = reply.code ? pending.find((item) => item.code === reply.code) : pending[0];
  if (!target) return null;
  const [approval] = await getDb()
    .select({ id: schema.approvals.id })
    .from(schema.approvals)
    .where(and(eq(schema.approvals.id, target.id), eq(schema.approvals.agentId, addressed.channel.agentId)));
  await dropFromChannelList(addressed.channel.id, "approvals", target.id);
  if (!approval) return null;
  const ok = await hub.answerApproval(approval.id, reply.approved, undefined, addressed.owner.id, false, "whatsapp");
  const status = ok ? (reply.approved ? "approved" : "denied") : ((await hub.approvalStatus(approval.id)) ?? "closed");
  await context.reply(ok ? copy.channels.answerDone(reply.approved) : copy.channels.answerClosed(copy.approvals.status[status] ?? status));
  return ok ? "answered" : "closed";
}

export async function handleWhatsAppMessage(hub: Hub, context: WhatsAppContext) {
  const { inbound, me, now } = context;
  if (inbound.at && now - inbound.at > STALE_MS) return "stale";
  const addressed = await channelByAddress("whatsapp", context.channelId);
  if (!addressed) return "not_connected";
  const { channel, owner } = addressed;
  const self = isSelfChat(inbound, me);
  if (self && (!inbound.fromMe || inbound.id.startsWith(OWN_MESSAGE_PREFIX))) return "echo";
  if (!self && inbound.fromMe) return "own_conversation";
  const peer = self ? me.number : peerOf(inbound);
  const allowed = self || peerListed("whatsapp", [peer], channel.allowedSenders);
  if (!allowed && channel.unknownSenders === "ignore") return "sender_not_allowed";
  if (!limiter.allow(`channel-whatsapp:${channel.id}`, 0.5, 20) || !limiter.allow(`channel-whatsapp-peer:${channel.id}:${peer}`, 0.2, 10)) return "too_many_messages";
  if (self) {
    const answered = await answerFromChat(hub, addressed, context);
    if (answered) return answered;
  }
  const attachments = await attachmentOf(context);
  if (!inbound.text.trim() && !attachments.length) return "empty";
  const peerName = self ? owner.name : inbound.pushName;
  if (!allowed) {
    return holdMessage(hub, addressed, { peer, peerName, held: heldCopy({ subject: "", text: inbound.text, date: inbound.at ? new Date(inbound.at).toISOString() : null, attachments }), lastMessageId: inbound.id });
  }
  const thread = await openPeerThread(addressed, { peer, peerName, trusted: self, messageId: inbound.id }, now);
  const result = await deliverToAgent(hub, { kind: "whatsapp", agentId: channel.agentId, owner, thread, trusted: self, text: inbound.text, attachments }, now);
  return result.status === "sent" ? "delivered" : "queued";
}
