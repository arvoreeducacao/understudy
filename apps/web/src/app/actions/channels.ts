"use server";

import { revalidatePath } from "next/cache";
import type { UnknownSenders } from "@/lib/db/schema";
import { getHub } from "@/server/hub-access";
import { disableEmailChannel, discardHeld, enableEmailChannel, releaseHeld, setEmailSenders, setUnknownSenders } from "@/server/channels/settings";
import { emailChannelReady } from "@/server/channels/email/address";
import { ownAgent } from "./shared";

function refresh(agentId: string) {
  revalidatePath(`/agents/${agentId}`, "layout");
}

export async function setEmailChannel(agentId: string, enabled: boolean) {
  const { agent } = await ownAgent(agentId);
  if (!enabled) {
    await disableEmailChannel(agent.id);
    refresh(agent.id);
    return { address: null };
  }
  if (!emailChannelReady()) return { address: null };
  const address = await enableEmailChannel(agent.id, agent.name);
  refresh(agent.id);
  return { address };
}

export async function saveEmailSenders(agentId: string, senders: string) {
  const { agent } = await ownAgent(agentId);
  const allowed = await setEmailSenders(agent.id, senders);
  refresh(agent.id);
  return { allowed };
}

export async function saveUnknownSenders(agentId: string, mode: UnknownSenders) {
  const { agent } = await ownAgent(agentId);
  const value = await setUnknownSenders(agent.id, mode);
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
