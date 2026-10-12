"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { setToolLimits } from "@/server/tool-access";

export async function setConnectorCeiling(id: string, input: { askAll: boolean; ask: string[]; never: string[] }) {
  const admin = await requireAdmin();
  const [server] = await getDb().select({ id: schema.mcpServers.id }).from(schema.mcpServers).where(eq(schema.mcpServers.id, String(id)));
  if (!server) return { ok: false };
  await getDb().update(schema.mcpServers).set({ askAll: input.askAll === true }).where(eq(schema.mcpServers.id, server.id));
  const saved = await setToolLimits(server.id, { ask: input.ask, never: input.never }, admin.id);
  revalidatePath("/admin", "layout");
  return { ok: true, ...saved };
}
