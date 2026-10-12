import type { ChannelKind } from "@/lib/db/schema";
import { parseSenderList } from "../inbound-email/policy";

const TELEGRAM_PEER = /^([a-z][a-z0-9_]{4,31}|\d{3,15})$/;
const PHONE_PEER = /^\+[1-9]\d{6,14}$/;

export function cleanPeerList(kind: ChannelKind, value: string) {
  const entries = String(value ?? "")
    .split(kind === "whatsapp" || kind === "sms" ? /[,;\n]+/ : /[\s,;]+/)
    .map((entry) => entry.trim().toLowerCase().replace(/^@/, ""))
    .map((entry) => (kind === "whatsapp" || kind === "sms" ? entry.replace(/[^\d+]/g, "").replace(/^(?=\d)/, "+") : entry))
    .filter((entry) => (kind === "telegram" ? TELEGRAM_PEER.test(entry) : kind === "whatsapp" || kind === "sms" ? PHONE_PEER.test(entry) : entry.length > 0 && entry.length <= 320));
  return [...new Set(entries)].slice(0, 50).join(", ");
}

export function peerListed(kind: ChannelKind, ids: string[], allowed: string | null) {
  const rules = parseSenderList(allowed);
  const wanted = ids.map((id) => id.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
  return rules.some((rule) => wanted.includes(rule));
}
