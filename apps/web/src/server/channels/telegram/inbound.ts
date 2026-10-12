import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/ids";
import { messages as copy } from "@/lib/messages";
import { open } from "@/lib/secret-box";
import type { Hub } from "../../hub";
import type { ParsedAttachment } from "../../inbound-email/parse";
import { safeFilename } from "../../inbound-email/parse";
import { RateLimiter } from "../../rate-limit";
import { deliverToAgent, heldCopy, holdMessage } from "../deliver";
import { bindPeer, peerListed } from "../peers";
import { setChannelSenders } from "../settings";
import { mergeChannelSettings, type AddressedChannel, type ChannelThread } from "../store";
import { telegramCall, telegramDownload } from "./api";
import { pairCode, sameValue } from "./keys";
import { telegramSettings } from "./settings";

const limiter = new RateLimiter();

export type TelegramUser = { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string };

export type TelegramMessage = {
  message_id: number;
  from?: TelegramUser;
  chat: { id: number; type: string };
  date?: number;
  text?: string;
  caption?: string;
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  photo?: { file_id: string; file_size?: number; width?: number; height?: number }[];
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: { id: string; from: TelegramUser; data?: string; message?: TelegramMessage };
};

function log(event: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
}

export function telegramName(user: TelegramUser) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim().slice(0, 120);
  const handle = user.username ? `@${user.username}` : "";
  return [name, handle].filter(Boolean).join(" ") || null;
}

async function attachmentsOf(token: string, message: TelegramMessage): Promise<ParsedAttachment[]> {
  const wanted: { fileId: string; name: string; mime: string }[] = [];
  if (message.document) wanted.push({ fileId: message.document.file_id, name: safeFilename(message.document.file_name, 0), mime: message.document.mime_type || "application/octet-stream" });
  const photo = message.photo?.at(-1);
  if (photo) wanted.push({ fileId: photo.file_id, name: `photo-${message.message_id}.jpg`, mime: "image/jpeg" });
  const files: ParsedAttachment[] = [];
  for (const file of wanted) {
    const data = await telegramDownload(token, file.fileId);
    if (data) files.push({ filename: file.name, mimeType: file.mime, base64: data.toString("base64"), bytes: data.length });
  }
  return files;
}

async function openThread(addressed: AddressedChannel, peer: string, peerName: string | null, trusted: boolean, messageId: string, now: number): Promise<ChannelThread> {
  const db = getDb();
  const [existing] = await db
    .select()
    .from(schema.channelThreads)
    .where(and(eq(schema.channelThreads.channelId, addressed.channel.id), eq(schema.channelThreads.peer, peer), eq(schema.channelThreads.status, "open")))
    .orderBy(desc(schema.channelThreads.updatedAt))
    .limit(1);
  if (existing) {
    const [updated] = await db
      .update(schema.channelThreads)
      .set({ lastMessageId: messageId, peerName: peerName ?? existing.peerName, trusted, updatedAt: new Date(now) })
      .where(eq(schema.channelThreads.id, existing.id))
      .returning();
    return updated;
  }
  const [created] = await db
    .insert(schema.channelThreads)
    .values({ id: newId("cth"), agentId: addressed.channel.agentId, channelId: addressed.channel.id, peer, peerName, trusted, lastMessageId: messageId })
    .returning();
  return created;
}

async function onMessage(hub: Hub, addressed: AddressedChannel, token: string, message: TelegramMessage, now: number) {
  const { channel, owner } = addressed;
  const from = message.from;
  if (!from || from.is_bot || message.chat.type !== "private") return "ignored";
  const settings = telegramSettings(channel);
  const peer = String(from.id);
  const text = (message.text ?? message.caption ?? "").slice(0, 8000);
  const start = text.match(/^\/start(?:\s+(\S+))?\s*$/);
  if (start) {
    const code = start[1] ?? "";
    if (code && sameValue(code, pairCode(channel.id, settings.pairVersion ?? 1))) {
      await mergeChannelSettings(channel.id, { ownerUserId: peer, ownerName: telegramName(from) ?? peer, pairVersion: (settings.pairVersion ?? 1) + 1 });
      await telegramCall(token, "sendMessage", { chat_id: message.chat.id, text: copy.channels.telegramPaired(addressed.agentName) });
      log("telegram_paired", { agentId: channel.agentId });
      return "paired";
    }
    if (settings.ownerUserId === peer || !code) return "ignored";
  }
  const trusted = settings.ownerUserId === peer;
  const byId = peerListed("telegram", [peer], channel.allowedSenders);
  const bound = !trusted && !byId && from.username ? bindPeer(channel.allowedSenders, from.username, peer) : null;
  if (bound !== null) await setChannelSenders(channel.agentId, "telegram", bound);
  const allowed = trusted || byId || bound !== null;
  if (!allowed && channel.unknownSenders === "ignore") return "sender_not_allowed";
  if (!limiter.allow(`channel-telegram:${channel.id}`, 0.5, 20) || !limiter.allow(`channel-telegram-peer:${channel.id}:${peer}`, 0.2, 10)) return "too_many_messages";
  const attachments = await attachmentsOf(token, message);
  if (!text.trim() && !attachments.length) return "empty";
  const peerName = telegramName(from);
  if (!allowed) {
    return holdMessage(hub, addressed, { peer, peerName, held: heldCopy({ subject: "", text, date: message.date ? new Date(message.date * 1000).toISOString() : null, attachments }), lastMessageId: String(message.message_id) });
  }
  const thread = await openThread(addressed, peer, peerName, trusted, String(message.message_id), now);
  const result = await deliverToAgent(hub, { kind: "telegram", agentId: channel.agentId, owner, thread, trusted, text, attachments }, now);
  if (result.status === "sent") await telegramCall(token, "sendChatAction", { chat_id: message.chat.id, action: "typing" }).catch(() => undefined);
  return result.status === "sent" ? "delivered" : "queued";
}

async function onCallback(hub: Hub, addressed: AddressedChannel, token: string, query: NonNullable<TelegramUpdate["callback_query"]>) {
  const { channel, owner } = addressed;
  const settings = telegramSettings(channel);
  const match = query.data?.match(/^apr:(apr_[A-Za-z0-9_-]{6,80}):([yna])$/);
  if (!match) return "ignored";
  const answer = (text: string) => telegramCall(token, "answerCallbackQuery", { callback_query_id: query.id, text: text.slice(0, 190) });
  if (!settings.ownerUserId || String(query.from.id) !== settings.ownerUserId) {
    await answer(copy.channels.telegramNotOwner);
    return "not_owner";
  }
  const [approval] = await getDb()
    .select({ id: schema.approvals.id, summary: schema.approvals.summary })
    .from(schema.approvals)
    .where(and(eq(schema.approvals.id, match[1]), eq(schema.approvals.agentId, channel.agentId)));
  if (!approval) {
    await answer(copy.channels.answerMissing);
    return "unknown_approval";
  }
  const approved = match[2] !== "n";
  const ok = await hub.answerApproval(approval.id, approved, undefined, owner.id, match[2] === "a");
  const status = ok ? (approved ? "approved" : "denied") : ((await hub.approvalStatus(approval.id)) ?? "closed");
  const outcome = ok ? copy.channels.answerDone(approved) : copy.channels.answerClosed(copy.approvals.status[status] ?? status);
  await answer(outcome);
  if (query.message) {
    const original = (query.message.text ?? "").slice(0, 3800);
    await telegramCall(token, "editMessageText", { chat_id: query.message.chat.id, message_id: query.message.message_id, text: `${original}\n\n${outcome}` });
  }
  return ok ? "answered" : "closed";
}

export async function handleTelegramUpdate(hub: Hub, addressed: AddressedChannel, update: TelegramUpdate, now = Date.now()) {
  const token = addressed.channel.secret ? open(addressed.channel.secret) : "";
  if (!token) return "not_connected";
  if (update.callback_query) return onCallback(hub, addressed, token, update.callback_query);
  if (update.message) return onMessage(hub, addressed, token, update.message, now);
  return "ignored";
}
