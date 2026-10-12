import { eq } from "drizzle-orm";
import QRCode from "qrcode";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/ids";
import type { Hub } from "../../hub";
import { agentChannel } from "../store";

export type WhatsAppView = { state: "off" | "connecting" | "qr" | "open" | "closed" | "logged_out"; qr: string | null; number: string | null };

export function maskNumber(number: string | null | undefined) {
  if (!number) return null;
  const digits = number.replace(/\D/g, "");
  return digits.length > 4 ? `+${"•".repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}` : number;
}

export async function connectWhatsApp(hub: Hub, agentId: string) {
  const db = getDb();
  let channel = await agentChannel(agentId, "whatsapp");
  if (!channel) {
    const id = newId("chn");
    [channel] = await db.insert(schema.agentChannels).values({ id, agentId, kind: "whatsapp", address: id, unknownSenders: "ignore", settings: { linked: false } }).returning();
  }
  await hub.whatsapp.start(channel.id);
  return channel.id;
}

export async function disconnectWhatsApp(hub: Hub, agentId: string) {
  const channel = await agentChannel(agentId, "whatsapp");
  if (!channel) return;
  await hub.whatsapp.stop(channel.id, true);
  await getDb().delete(schema.agentChannels).where(eq(schema.agentChannels.id, channel.id));
}

export async function whatsappView(hub: Hub | null, agentId: string): Promise<WhatsAppView> {
  const channel = await agentChannel(agentId, "whatsapp");
  if (!channel) return { state: "off", qr: null, number: null };
  const live = hub?.whatsapp.status(channel.id) ?? null;
  const settings = channel.settings as { linked?: boolean; number?: string };
  const state = live?.state ?? (settings.linked ? "connecting" : "closed");
  const qr = state === "qr" && live?.qr ? await QRCode.toDataURL(live.qr, { margin: 1, width: 240 }) : null;
  return { state, qr, number: maskNumber(live?.number ?? settings.number) };
}
