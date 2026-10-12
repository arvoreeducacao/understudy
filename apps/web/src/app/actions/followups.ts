"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { cancelFollowup } from "@/server/followups";

export async function cancelFollowupAction(followupId: string) {
  const user = await requireUser();
  const [row] = await getDb()
    .select({ agentId: schema.followups.agentId })
    .from(schema.followups)
    .innerJoin(schema.agents, eq(schema.agents.id, schema.followups.agentId))
    .where(and(eq(schema.followups.id, String(followupId)), eq(schema.agents.ownerId, user.id)));
  if (!row) return { ok: false as const };
  const cancelled = await cancelFollowup(row.agentId, String(followupId), user.id);
  if (!cancelled) return { ok: false as const };
  revalidatePath(`/agents/${row.agentId}`, "layout");
  revalidatePath("/today");
  revalidatePath("/runs");
  return { ok: true as const };
}
