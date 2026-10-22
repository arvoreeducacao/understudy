"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { canManageConnector } from "@/server/connector-rights";
import { setToolLimits } from "@/server/tool-access";

export async function setConnectorCeiling(id: string, input: { askAll: boolean; ask: string[]; never: string[] }) {
  const user = await requireUser();
  const [server] = await getDb().select().from(schema.mcpServers).where(eq(schema.mcpServers.id, String(id)));
  if (!server || !canManageConnector(user, server)) return { ok: false };
  await getDb().update(schema.mcpServers).set({ askAll: input.askAll === true }).where(eq(schema.mcpServers.id, server.id));
  const saved = await setToolLimits(server.id, { ask: input.ask, never: input.never }, user.id);
  revalidatePath("/connectors", "layout");
  return { ok: true, ...saved };
}
