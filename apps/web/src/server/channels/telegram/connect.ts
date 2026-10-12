import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { newId } from "@/lib/ids";
import { open, seal } from "@/lib/secret-box";
import { agentChannel, mergeChannelSettings } from "../store";
import { TELEGRAM_TOKEN, telegramCall } from "./api";
import { webhookSecret } from "./keys";
import { telegramMode, telegramSettings } from "./settings";

export type ConnectResult = { ok: true; username: string } | { ok: false; error: "bad_token" | "rejected" | "taken" | "webhook_failed" };

export function telegramWebhookUrl(channelId: string) {
  return `${env.publicUrl}/api/channels/telegram/${channelId}`;
}

export async function connectTelegram(agentId: string, rawToken: string): Promise<ConnectResult> {
  const token = String(rawToken ?? "").trim();
  if (!TELEGRAM_TOKEN.test(token)) return { ok: false, error: "bad_token" };
  const me = await telegramCall<{ id: number; is_bot: boolean; username?: string }>(token, "getMe");
  if (!me.ok || !me.result.is_bot || !me.result.username) return { ok: false, error: "rejected" };
  const db = getDb();
  const address = String(me.result.id);
  const [other] = await db
    .select({ agentId: schema.agentChannels.agentId })
    .from(schema.agentChannels)
    .where(and(eq(schema.agentChannels.kind, "telegram"), eq(schema.agentChannels.address, address)));
  if (other && other.agentId !== agentId) return { ok: false, error: "taken" };
  const mode = telegramMode(env.publicUrl);
  const existing = await agentChannel(agentId, "telegram");
  const sameBot = existing?.address === address;
  const settings = { ...(sameBot ? telegramSettings(existing) : { pairVersion: 1 }), username: me.result.username, mode };
  const id = existing?.id ?? newId("chn");
  if (existing) {
    await db.update(schema.agentChannels).set({ address, secret: seal(token), settings, updatedAt: new Date() }).where(eq(schema.agentChannels.id, existing.id));
    if (!sameBot) await db.delete(schema.channelThreads).where(eq(schema.channelThreads.channelId, existing.id));
  } else {
    await db.insert(schema.agentChannels).values({ id, agentId, kind: "telegram", address, secret: seal(token), settings });
  }
  const hook =
    mode === "webhook"
      ? await telegramCall(token, "setWebhook", { url: telegramWebhookUrl(id), secret_token: webhookSecret(id), allowed_updates: ["message", "callback_query"], drop_pending_updates: true })
      : await telegramCall(token, "deleteWebhook", { drop_pending_updates: true });
  if (!hook.ok) return { ok: false, error: "webhook_failed" };
  return { ok: true, username: me.result.username };
}

export async function disconnectTelegram(agentId: string) {
  const channel = await agentChannel(agentId, "telegram");
  if (!channel) return;
  const token = channel.secret ? open(channel.secret) : "";
  if (token) await telegramCall(token, "deleteWebhook", {}).catch(() => undefined);
  await getDb().delete(schema.agentChannels).where(eq(schema.agentChannels.id, channel.id));
}

export async function forgetTelegramOwner(agentId: string) {
  const channel = await agentChannel(agentId, "telegram");
  if (!channel) return;
  await mergeChannelSettings(channel.id, { pairVersion: (telegramSettings(channel).pairVersion ?? 1) + 1 }, ["ownerUserId", "ownerName"]);
}
