import { createHash, createHmac, timingSafeEqual } from "node:crypto";

function key() {
  const secret = process.env.UNDERSTUDY_SECRET_KEY?.trim() || process.env.BETTER_AUTH_SECRET?.trim();
  if (!secret) throw new Error("UNDERSTUDY_SECRET_KEY or BETTER_AUTH_SECRET must be set");
  return createHash("sha256").update(`${secret}:understudy-telegram`).digest();
}

function mac(purpose: string, channelId: string, length: number) {
  return createHmac("sha256", key()).update(`${purpose}:${channelId}`).digest("base64url").replace(/[^A-Za-z0-9]/g, "").slice(0, length);
}

export function webhookSecret(channelId: string) {
  return mac("webhook", channelId, 48);
}

export function pairCode(channelId: string, version: number) {
  return mac(`pair:${version}`, channelId, 24);
}

export function sameValue(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
