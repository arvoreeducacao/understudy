"use server";

import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { isLocale } from "@/lib/messages";
import { requireUser } from "@/lib/session";

export async function setLanguage(locale: string) {
  const user = await requireUser();
  if (!isLocale(locale)) return { ok: false };
  await getDb().update(schema.user).set({ locale, updatedAt: new Date() }).where(eq(schema.user.id, user.id));
  return { ok: true };
}
