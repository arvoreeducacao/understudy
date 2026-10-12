"use server";

import { revalidatePath } from "next/cache";
import type { ChannelKind, UnknownSenders } from "@/lib/db/schema";
import { getHub } from "@/server/hub-access";
import { discardHeld, releaseHeld, setChannelSenders, setUnknownSenders } from "@/server/channels/settings";
import { channelEnabled } from "@/server/channels/enabled";
import { connectTelegram, disconnectTelegram, forgetTelegramOwner } from "@/server/channels/telegram/connect";
import { connectWhatsApp, disconnectWhatsApp, whatsappView } from "@/server/channels/whatsapp/connect";
import { ownAgent } from "./shared";

const KINDS: ChannelKind[] = ["telegram", "whatsapp"];

function kindOf(value: unknown): ChannelKind | null {
  return KINDS.find((kind) => kind === value) ?? null;
}

function refresh(agentId: string) {
  revalidatePath(`/agents/${agentId}`, "layout");
}

export async function saveChannelSenders(agentId: string, kind: ChannelKind, senders: string) {
  const { agent } = await ownAgent(agentId);
  const channel = kindOf(kind);
  if (!channel) return { allowed: "" };
  const allowed = await setChannelSenders(agent.id, channel, senders);
  refresh(agent.id);
  return { allowed };
}

export async function saveUnknownSenders(agentId: string, kind: ChannelKind, mode: UnknownSenders) {
  const { agent } = await ownAgent(agentId);
  const channel = kindOf(kind);
  if (!channel) return { mode };
  const value = await setUnknownSenders(agent.id, channel, mode);
  refresh(agent.id);
  return { mode: value };
}

export async function answerHeld(agentId: string, threadId: string, action: "release" | "allow" | "discard") {
  const { agent, user } = await ownAgent(agentId);
  if (action === "discard") {
    const ok = await discardHeld(agent.id, String(threadId));
    refresh(agent.id);
    return { ok };
  }
  const hub = getHub();
  if (!hub) return { ok: false };
  const ok = await releaseHeld(hub, { id: user.id, name: user.name, email: user.email }, agent.id, String(threadId), action === "allow");
  refresh(agent.id);
  return { ok };
}

export async function setTelegramChannel(agentId: string, token: string | null) {
  const { agent } = await ownAgent(agentId);
  if (token === null) {
    await disconnectTelegram(agent.id);
    refresh(agent.id);
    return { ok: true as const };
  }
  if (!channelEnabled("telegram")) return { ok: false as const, error: "rejected" as const };
  const result = await connectTelegram(agent.id, token);
  refresh(agent.id);
  return result;
}

export async function relinkTelegramOwner(agentId: string) {
  const { agent } = await ownAgent(agentId);
  await forgetTelegramOwner(agent.id);
  refresh(agent.id);
  return { ok: true };
}

export async function setWhatsAppChannel(agentId: string, enabled: boolean) {
  const { agent } = await ownAgent(agentId);
  const hub = getHub();
  if (!hub) return { ok: false as const };
  if (!enabled) {
    await disconnectWhatsApp(hub, agent.id);
    refresh(agent.id);
    return { ok: true as const };
  }
  if (!channelEnabled("whatsapp")) return { ok: false as const };
  await connectWhatsApp(hub, agent.id);
  refresh(agent.id);
  return { ok: true as const };
}

export async function whatsappStatus(agentId: string) {
  const { agent } = await ownAgent(agentId);
  return whatsappView(getHub(), agent.id);
}
