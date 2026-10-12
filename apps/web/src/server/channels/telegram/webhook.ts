import type { IncomingMessage, ServerResponse } from "node:http";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { open } from "@/lib/secret-box";
import type { Hub } from "../../hub";
import { RateLimiter } from "../../rate-limit";
import { clientIp } from "../../webhook";
import { channelEnabled } from "../enabled";
import { channelByAddress, mergeChannelSettings, type AddressedChannel } from "../store";
import { telegramCall } from "./api";
import { handleTelegramUpdate, type TelegramUpdate } from "./inbound";
import { sameValue, webhookSecret } from "./keys";
import { telegramSettings } from "./settings";

const MAX_BODY_BYTES = 256 * 1024;
const PREFIX = "/api/channels/telegram/";
const limiter = new RateLimiter();
const seen = new Map<string, number>();

function log(event: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
}

function reply(res: ServerResponse, status: number) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: status < 300 }));
}

function firstTime(key: string, now = Date.now()) {
  for (const [id, at] of seen) if (now - at > 60 * 60 * 1000) seen.delete(id);
  if (seen.has(key)) return false;
  seen.set(key, now);
  return true;
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function isTelegramRoute(pathname: string) {
  return pathname.startsWith(PREFIX) && /^chn_[A-Za-z0-9_-]{6,80}$/.test(pathname.slice(PREFIX.length));
}

async function channelById(channelId: string): Promise<AddressedChannel | null> {
  const [row] = await getDb()
    .select({ address: schema.agentChannels.address })
    .from(schema.agentChannels)
    .where(and(eq(schema.agentChannels.id, channelId), eq(schema.agentChannels.kind, "telegram")));
  return row ? channelByAddress("telegram", row.address) : null;
}

export async function processTelegramUpdate(hub: Hub, addressed: AddressedChannel, update: TelegramUpdate) {
  if (typeof update?.update_id !== "number" || !firstTime(`${addressed.channel.id}:${update.update_id}`)) return "duplicate";
  const outcome = await handleTelegramUpdate(hub, addressed, update);
  log("telegram_update", { agentId: addressed.channel.agentId, outcome });
  return outcome;
}

export async function handleTelegramWebhook(hub: Hub, req: IncomingMessage, res: ServerResponse, pathname: string) {
  if (req.method !== "POST") return reply(res, 405);
  if (!channelEnabled("telegram")) return reply(res, 404);
  if (!limiter.allow(`telegram-ip:${clientIp(req)}`, 20, 200)) return reply(res, 429);
  const channelId = pathname.slice(PREFIX.length);
  const given = req.headers["x-telegram-bot-api-secret-token"];
  if (typeof given !== "string" || !sameValue(given, webhookSecret(channelId))) return reply(res, 401);
  const body = await readBody(req);
  if (body === null) return reply(res, 413);
  let update: TelegramUpdate;
  try {
    update = JSON.parse(body) as TelegramUpdate;
  } catch {
    return reply(res, 400);
  }
  const addressed = await channelById(channelId);
  if (!addressed) return reply(res, 404);
  reply(res, 200);
  await processTelegramUpdate(hub, addressed, update).catch((error) => log("telegram_update_error", { error: String(error).slice(0, 300) }));
}

const POLL_MS = 2500;

export async function pollTelegramOnce(hub: Hub) {
  if (!channelEnabled("telegram")) return;
  const rows = await getDb().select({ address: schema.agentChannels.address }).from(schema.agentChannels).where(eq(schema.agentChannels.kind, "telegram"));
  for (const row of rows) {
    const addressed = await channelByAddress("telegram", row.address);
    if (!addressed?.channel.secret) continue;
    const settings = telegramSettings(addressed.channel);
    if (settings.mode !== "poll") continue;
    const token = open(addressed.channel.secret);
    const updates = await telegramCall<TelegramUpdate[]>(token, "getUpdates", { offset: (settings.offset ?? 0) + 1, timeout: 0, allowed_updates: ["message", "callback_query"] });
    if (!updates.ok || !updates.result.length) continue;
    const offset = Math.max(...updates.result.map((update) => update.update_id));
    await mergeChannelSettings(addressed.channel.id, { offset });
    for (const update of updates.result) await processTelegramUpdate(hub, addressed, update).catch((error) => log("telegram_update_error", { error: String(error).slice(0, 300) }));
  }
}

export function startTelegramPolling(hub: Hub) {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    pollTelegramOnce(hub)
      .catch((error) => log("telegram_poll_error", { error: String(error).slice(0, 300) }))
      .finally(() => {
        running = false;
      });
  }, POLL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
