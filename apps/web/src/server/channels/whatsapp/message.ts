import { isJidBroadcast, isJidGroup, isJidStatusBroadcast, isLidUser, isPnUser, jidNormalizedUser, normalizeMessageContent, type WAMessage } from "baileys";
import { safeFilename } from "../../inbound-email/parse";

export const OWN_MESSAGE_PREFIX = "USTD";

export type WaMedia = { kind: "image" | "document" | "audio" | "video"; mime: string; filename: string; bytes: number };

export type WaInbound = { id: string; fromMe: boolean; chat: string; chatAlt: string | null; text: string; pushName: string | null; at: number; media: WaMedia | null };

export type WaIdentity = { jid: string; lid: string | null; number: string };

export function phoneOf(jid: string | null | undefined) {
  if (!jid || !isPnUser(jid)) return null;
  const digits = jidNormalizedUser(jid).split("@")[0]?.replace(/\D/g, "") ?? "";
  return digits.length >= 7 ? `+${digits}` : null;
}

export function jidOf(peer: string) {
  return peer.startsWith("+") ? `${peer.slice(1)}@s.whatsapp.net` : peer;
}

export function identityOf(user: { id: string; lid?: string } | undefined): WaIdentity | null {
  if (!user?.id) return null;
  const jid = jidNormalizedUser(user.id);
  const number = phoneOf(jid);
  if (!number) return null;
  return { jid, lid: user.lid ? jidNormalizedUser(user.lid) : null, number };
}

function stampOf(value: WAMessage["messageTimestamp"]) {
  if (typeof value === "number") return value * 1000;
  if (value && typeof value === "object" && "toNumber" in value) return (value as { toNumber(): number }).toNumber() * 1000;
  return 0;
}

export function readMessage(message: WAMessage): WaInbound | null {
  const chat = message.key.remoteJid ?? "";
  if (!chat || isJidGroup(chat) || isJidBroadcast(chat) || isJidStatusBroadcast(chat) || chat.endsWith("@newsletter")) return null;
  if (!isPnUser(chat) && !isLidUser(chat)) return null;
  const content = normalizeMessageContent(message.message);
  if (!content) return null;
  const document = content.documentMessage ?? content.documentWithCaptionMessage?.message?.documentMessage ?? null;
  const text =
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    document?.caption ??
    "";
  const size = (value: unknown) => Number(value ?? 0) || 0;
  const media: WaMedia | null = content.imageMessage
    ? { kind: "image", mime: content.imageMessage.mimetype ?? "image/jpeg", filename: `photo-${message.key.id}.jpg`, bytes: size(content.imageMessage.fileLength) }
    : document
      ? { kind: "document", mime: document.mimetype ?? "application/octet-stream", filename: safeFilename(document.fileName, 0), bytes: size(document.fileLength) }
      : content.audioMessage
        ? { kind: "audio", mime: content.audioMessage.mimetype ?? "audio/ogg", filename: `voice-${message.key.id}.ogg`, bytes: size(content.audioMessage.fileLength) }
        : content.videoMessage
          ? { kind: "video", mime: content.videoMessage.mimetype ?? "video/mp4", filename: `video-${message.key.id}.mp4`, bytes: size(content.videoMessage.fileLength) }
          : null;
  if (!text.trim() && !media) return null;
  return {
    id: message.key.id ?? "",
    fromMe: Boolean(message.key.fromMe),
    chat: jidNormalizedUser(chat),
    chatAlt: message.key.remoteJidAlt ? jidNormalizedUser(message.key.remoteJidAlt) : null,
    text: text.slice(0, 8000),
    pushName: message.pushName?.trim().slice(0, 120) || null,
    at: stampOf(message.messageTimestamp),
    media,
  };
}

export function isSelfChat(inbound: Pick<WaInbound, "chat" | "chatAlt">, me: WaIdentity) {
  return [inbound.chat, inbound.chatAlt].some((jid) => jid && (jid === me.jid || jid === me.lid));
}

export function peerOf(inbound: Pick<WaInbound, "chat" | "chatAlt">) {
  return phoneOf(inbound.chat) ?? phoneOf(inbound.chatAlt) ?? inbound.chat;
}

const APPROVE = /^(1|yes|y|ok|approve|approved|sim|s|aprovar|aprovo|aprovado)$/i;
const DENY = /^(2|no|n|deny|denied|n[aã]o|negar|nego|negado)$/i;

export function parseApprovalReply(text: string): { approved: boolean; code: string | null } | null {
  const words = text.trim().replace(/[.!]+$/, "").split(/\s+/);
  if (words.length < 1 || words.length > 2) return null;
  const [answer, code] = words;
  const approved = APPROVE.test(answer) ? true : DENY.test(answer) ? false : null;
  if (approved === null) return null;
  if (code && !/^[A-Za-z0-9]{3}$/.test(code)) return null;
  return { approved, code: code ? code.toUpperCase() : null };
}

export function paceMs(text: string, random = Math.random) {
  const base = Math.min(6000, 900 + text.length * 25);
  return Math.round(base * (0.85 + random() * 0.3));
}
