import { and, asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import type { UnknownSenders } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { cleanSenderList, inboundLocalPart } from "@/lib/inbound-address";
import type { Hub } from "../hub";
import { parseSenderList } from "../inbound-email/policy";
import { channelAddress, emailChannelDomain, emailChannelReady } from "./email/address";
import { deliverToAgent } from "./email/inbound";
import { agentChannel } from "./store";

export type HeldView = { id: string; peer: string; peerName: string | null; subject: string; preview: string; files: number; at: string };

export type EmailChannelView = {
  available: boolean;
  address: string | null;
  senders: string;
  unknown: UnknownSenders;
  held: HeldView[];
};

export type ChannelSettings = { email: EmailChannelView };

export async function channelSettings(agentId: string): Promise<ChannelSettings> {
  const channel = emailChannelDomain() ? await agentChannel(agentId, "email") : null;
  const held = channel
    ? await getDb()
        .select()
        .from(schema.channelThreads)
        .where(and(eq(schema.channelThreads.channelId, channel.id), eq(schema.channelThreads.status, "held")))
        .orderBy(asc(schema.channelThreads.createdAt))
        .limit(50)
    : [];
  return {
    email: {
      available: emailChannelReady(),
      address: channel ? channelAddress(channel.address) : null,
      senders: channel?.allowedSenders ?? "",
      unknown: channel?.unknownSenders ?? "hold",
      held: held.map((row) => ({
        id: row.id,
        peer: row.peer,
        peerName: row.peerName,
        subject: row.subject,
        preview: (row.held?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 240),
        files: row.held?.attachments.length ?? 0,
        at: row.createdAt.toISOString(),
      })),
    },
  };
}

export async function enableEmailChannel(agentId: string, agentName: string) {
  const address = inboundLocalPart(agentName);
  const db = getDb();
  const existing = await agentChannel(agentId, "email");
  if (existing) await db.update(schema.agentChannels).set({ address, updatedAt: new Date() }).where(eq(schema.agentChannels.id, existing.id));
  else await db.insert(schema.agentChannels).values({ id: newId("chn"), agentId, kind: "email", address });
  return channelAddress(address);
}

export async function disableEmailChannel(agentId: string) {
  await getDb().delete(schema.agentChannels).where(and(eq(schema.agentChannels.agentId, agentId), eq(schema.agentChannels.kind, "email")));
}

export async function setEmailSenders(agentId: string, senders: string) {
  const allowed = cleanSenderList(String(senders ?? ""));
  await getDb()
    .update(schema.agentChannels)
    .set({ allowedSenders: allowed || null, updatedAt: new Date() })
    .where(and(eq(schema.agentChannels.agentId, agentId), eq(schema.agentChannels.kind, "email")));
  return allowed;
}

export async function setUnknownSenders(agentId: string, mode: UnknownSenders) {
  const value: UnknownSenders = mode === "ignore" ? "ignore" : "hold";
  const db = getDb();
  await db
    .update(schema.agentChannels)
    .set({ unknownSenders: value, updatedAt: new Date() })
    .where(and(eq(schema.agentChannels.agentId, agentId), eq(schema.agentChannels.kind, "email")));
  if (value === "ignore") {
    const channel = await agentChannel(agentId, "email");
    if (channel) await db.delete(schema.channelThreads).where(and(eq(schema.channelThreads.channelId, channel.id), eq(schema.channelThreads.status, "held")));
  }
  return value;
}

async function heldThread(agentId: string, threadId: string) {
  const [row] = await getDb()
    .select()
    .from(schema.channelThreads)
    .where(and(eq(schema.channelThreads.id, threadId), eq(schema.channelThreads.agentId, agentId), eq(schema.channelThreads.status, "held")));
  return row ?? null;
}

export async function discardHeld(agentId: string, threadId: string) {
  const deleted = await getDb()
    .delete(schema.channelThreads)
    .where(and(eq(schema.channelThreads.id, threadId), eq(schema.channelThreads.agentId, agentId), eq(schema.channelThreads.status, "held")))
    .returning({ id: schema.channelThreads.id });
  return deleted.length > 0;
}

export async function releaseHeld(hub: Hub, owner: { id: string; name: string; email: string }, agentId: string, threadId: string, allow: boolean) {
  const thread = await heldThread(agentId, threadId);
  if (!thread?.held) return false;
  const db = getDb();
  const [claimed] = await db
    .update(schema.channelThreads)
    .set({ status: "open", held: null, updatedAt: new Date() })
    .where(and(eq(schema.channelThreads.id, threadId), eq(schema.channelThreads.status, "held")))
    .returning();
  if (!claimed) return false;
  if (allow) {
    const channel = await agentChannel(agentId, "email");
    if (channel) {
      const list = parseSenderList(channel.allowedSenders);
      if (!list.includes(thread.peer)) await setEmailSenders(agentId, [...list, thread.peer].join(", "));
    }
  }
  await deliverToAgent(hub, {
    agentId,
    owner,
    thread: claimed,
    trusted: false,
    subject: thread.held.subject,
    text: thread.held.text,
    attachments: thread.held.attachments,
    isNew: true,
  });
  return true;
}
