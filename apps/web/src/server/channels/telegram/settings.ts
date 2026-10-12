import type { AgentChannel } from "../store";

export type TelegramSettings = {
  username: string;
  mode: "webhook" | "poll";
  ownerUserId?: string;
  ownerName?: string;
  pairVersion?: number;
  offset?: number;
};

export function telegramSettings(channel: Pick<AgentChannel, "settings">): TelegramSettings {
  const raw = channel.settings as Partial<TelegramSettings>;
  return {
    username: typeof raw.username === "string" ? raw.username : "",
    mode: raw.mode === "poll" ? "poll" : "webhook",
    ...(typeof raw.ownerUserId === "string" ? { ownerUserId: raw.ownerUserId } : {}),
    ...(typeof raw.ownerName === "string" ? { ownerName: raw.ownerName } : {}),
    pairVersion: typeof raw.pairVersion === "number" ? raw.pairVersion : 1,
    ...(typeof raw.offset === "number" ? { offset: raw.offset } : {}),
  };
}

export function telegramMode(publicUrl: string, env: NodeJS.ProcessEnv = process.env): TelegramSettings["mode"] {
  if (env.UNDERSTUDY_TELEGRAM_POLL === "1") return "poll";
  return publicUrl.startsWith("https://") ? "webhook" : "poll";
}
