import { randomBytes } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import { getAuth } from "./auth";
import { getDb, schema } from "./db";
import { env } from "./env";

export const RESET_LINK_TTL_MS = 24 * 60 * 60 * 1000;

const PREFIX = "reset-password:";

export async function issueResetLink(userId: string, now = new Date()) {
  await getDb()
    .delete(schema.verification)
    .where(and(like(schema.verification.identifier, `${PREFIX}%`), eq(schema.verification.value, userId)));
  const token = randomBytes(24).toString("base64url");
  const ctx = await getAuth().$context;
  await ctx.internalAdapter.createVerificationValue({ identifier: `${PREFIX}${token}`, value: userId, expiresAt: new Date(now.getTime() + RESET_LINK_TTL_MS) });
  return `${env.publicUrl}/reset-password?token=${token}`;
}

export async function resetLinkOwner(token: string, now = new Date()) {
  if (!/^[A-Za-z0-9_-]{20,}$/.test(token)) return null;
  const ctx = await getAuth().$context;
  const row = await ctx.internalAdapter.findVerificationValue(`${PREFIX}${token}`);
  return row && row.expiresAt > now ? row.value : null;
}
