import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

export const APPROVAL_LINK_SECONDS = 24 * 60 * 60;

const APPROVAL_ID = /^apr_[A-Za-z0-9_-]{6,80}$/;

function key() {
  const secret = process.env.UNDERSTUDY_SECRET_KEY?.trim() || process.env.BETTER_AUTH_SECRET?.trim();
  if (!secret) throw new Error("UNDERSTUDY_SECRET_KEY or BETTER_AUTH_SECRET must be set");
  return createHash("sha256").update(`${secret}:understudy-approval-link`).digest();
}

function sign(payload: string) {
  return createHmac("sha256", key()).update(payload).digest("base64url");
}

export function approvalLinkToken(approvalId: string, now = Date.now(), seconds = APPROVAL_LINK_SECONDS) {
  if (!APPROVAL_ID.test(approvalId)) throw new Error("invalid approval id");
  const payload = `${approvalId}.${Math.floor(now / 1000) + seconds}`;
  return `${payload}.${sign(payload)}`;
}

export function readApprovalLinkToken(token: string, now = Date.now()): string | null {
  if (typeof token !== "string" || token.length > 300) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [approvalId, expires, signature] = parts;
  if (!APPROVAL_ID.test(approvalId) || !/^\d{1,12}$/.test(expires)) return null;
  const expected = Buffer.from(sign(`${approvalId}.${expires}`));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  if (Number(expires) * 1000 < now) return null;
  return approvalId;
}

export function approvalLinkUrl(approvalId: string, now = Date.now()) {
  return `${env.publicUrl}/answer/${approvalLinkToken(approvalId, now)}`;
}
