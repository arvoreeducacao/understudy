import { and, asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import type { ChannelKind, UnknownSenders } from "@/lib/db/schema";
import type { Hub } from "../hub";
import { parseSenderList } from "../inbound-email/policy";
import { deliverToAgent } from "./deliver";
import { channelEnabled } from "./enabled";
import { cleanPeerList } from "./peers";
import { agentChannel, type AgentChannel } from "./store";
import { pairCode } from "./telegram/keys";
import { telegramSettings } from "./telegram/settings";

export type HeldView = { id: string; peer: string; peerName: string | null; subject: string; preview: string; files: number; at: string };

type Shared = { senders: string; unknown: UnknownSenders; held: HeldView[] };

export type TelegramChannelView = Shared & { available: boolean; connected: boolean; username: string | null; ownerName: string | null; pairLink: string | null; polling: boolean };

export type WhatsAppChannelView = Shared & { available: boolean; connected: boolean };

export type ChannelSettings = { telegram: TelegramChannelView; whatsapp: WhatsAppChannelView };

async function heldOf(channel: AgentChannel | null): Promise<HeldView[]> {
  if (!channel) return [];
  const rows = await getDb()
    .select()
    .from(schema.channelThreads)
    .where(and(eq(schema.channelThreads.channelId, channel.id), eq(schema.channelThreads.status, "held")))
    .orderBy(asc(schema.channelThreads.createdAt))
    .limit(50);
  return rows.map((row) => ({
    id: row.id,
    peer: row.peer,
    peerName: row.peerName,
    subject: row.subject,
    preview: (row.held?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 240),
    files: row.held?.attachments.length ?? 0,
    at: row.createdAt.toISOString(),
  }));
}

function shared(channel: AgentChannel | null, held: HeldView[]): Shared {
  return { senders: channel?.allowedSenders ?? "", unknown: channel?.unknownSenders ?? "hold", held };
}

export async function channelSettings(agentId: string): Promise<ChannelSettings> {
  const telegram = await agentChannel(agentId, "telegram");
  const telegramHeld = await heldOf(telegram);
  const whatsapp = await agentChannel(agentId, "whatsapp");
  const whatsappHeld = await heldOf(whatsapp);
  const tg = telegram ? telegramSettings(telegram) : null;
  return {
    telegram: {
      ...shared(telegram, telegramHeld),
      available: channelEnabled("telegram"),
      connected: Boolean(telegram),
      username: tg?.username || null,
      ownerName: tg?.ownerName ?? null,
      pairLink: telegram && tg?.username && !tg.ownerUserId ? `https://t.me/${tg.username}?start=${pairCode(telegram.id, tg.pairVersion ?? 1)}` : null,
      polling: tg?.mode === "poll",
    },
    whatsapp: { ...shared(whatsapp, whatsappHeld), unknown: whatsapp?.unknownSenders ?? "ignore", available: channelEnabled("whatsapp"), connected: Boolean(whatsapp) },
  };
}

export async function setChannelSenders(agentId: string, kind: ChannelKind, senders: string) {
  const allowed = cleanPeerList(kind, String(senders ?? ""));
  await getDb()
    .update(schema.agentChannels)
    .set({ allowedSenders: allowed || null, updatedAt: new Date() })
    .where(and(eq(schema.agentChannels.agentId, agentId), eq(schema.agentChannels.kind, kind)));
  return allowed;
}

export async function setUnknownSenders(agentId: string, kind: ChannelKind, mode: UnknownSenders) {
  const value: UnknownSenders = mode === "ignore" ? "ignore" : "hold";
  const db = getDb();
  await db
    .update(schema.agentChannels)
    .set({ unknownSenders: value, updatedAt: new Date() })
    .where(and(eq(schema.agentChannels.agentId, agentId), eq(schema.agentChannels.kind, kind)));
  if (value === "ignore") {
    const channel = await agentChannel(agentId, kind);
    if (channel) await db.delete(schema.channelThreads).where(and(eq(schema.channelThreads.channelId, channel.id), eq(schema.channelThreads.status, "held")));
  }
  return value;
}

export async function discardHeld(agentId: string, threadId: string) {
  const deleted = await getDb()
    .delete(schema.channelThreads)
    .where(and(eq(schema.channelThreads.id, threadId), eq(schema.channelThreads.agentId, agentId), eq(schema.channelThreads.status, "held")))
    .returning({ id: schema.channelThreads.id });
  return deleted.length > 0;
}

export async function releaseHeld(hub: Hub, owner: { id: string; name: string; email: string }, agentId: string, threadId: string, allow: boolean) {
  const db = getDb();
  const [row] = await db
    .select({ thread: schema.channelThreads, channel: schema.agentChannels })
    .from(schema.channelThreads)
    .innerJoin(schema.agentChannels, eq(schema.agentChannels.id, schema.channelThreads.channelId))
    .where(and(eq(schema.channelThreads.id, threadId), eq(schema.channelThreads.agentId, agentId), eq(schema.channelThreads.status, "held")));
  const held = row?.thread.held;
  if (!row || !held) return false;
  const [claimed] = await db
    .update(schema.channelThreads)
    .set({ status: "open", held: null, updatedAt: new Date() })
    .where(and(eq(schema.channelThreads.id, threadId), eq(schema.channelThreads.status, "held")))
    .returning();
  if (!claimed) return false;
  const kind = row.channel.kind;
  if (allow) {
    const list = parseSenderList(row.channel.allowedSenders);
    if (!list.includes(row.thread.peer)) await setChannelSenders(agentId, kind, [...list, row.thread.peer].join(", "));
  }
  const text = held.subject ? `${held.subject}\n\n${held.text}` : held.text;
  await deliverToAgent(hub, { kind, agentId, owner, thread: claimed, trusted: false, text, attachments: held.attachments });
  return true;
}
