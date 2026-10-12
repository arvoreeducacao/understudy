import type { ChannelKind } from "@/lib/db/schema";

export const DEFAULT_CHANNELS: ChannelKind[] = ["telegram", "whatsapp"];

export function channelEnabled(kind: ChannelKind, env: NodeJS.ProcessEnv = process.env) {
  const raw = env.UNDERSTUDY_CHANNELS;
  const list = raw === undefined ? DEFAULT_CHANNELS : raw.split(",").map((item) => item.trim().toLowerCase());
  return list.includes(kind);
}
