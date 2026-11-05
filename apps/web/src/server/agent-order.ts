import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";

export async function loadAgentOrder(userId: string): Promise<string[]> {
  const [row] = await getDb().select({ agentOrder: schema.user.agentOrder }).from(schema.user).where(eq(schema.user.id, userId));
  return Array.isArray(row?.agentOrder) ? row.agentOrder.filter((id): id is string => typeof id === "string") : [];
}
