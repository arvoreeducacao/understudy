import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import type { ChannelKind } from "@/lib/db/schema";

export type TurnOrigin = { threadId: string; kind: ChannelKind; trusted: boolean };

export const OUTSIDER_TOOLS = new Set(["request_approval", "wait_for_approval", "notify_owner"]);

const turns = new Map<string, TurnOrigin | null>();

export async function startTurn(agentId: string, origin: string | undefined) {
  if (!origin) {
    turns.set(agentId, null);
    return null;
  }
  const [row] = await getDb()
    .select({ threadId: schema.channelThreads.id, trusted: schema.channelThreads.trusted, kind: schema.agentChannels.kind })
    .from(schema.channelThreads)
    .innerJoin(schema.agentChannels, eq(schema.agentChannels.id, schema.channelThreads.channelId))
    .where(and(eq(schema.channelThreads.id, origin), eq(schema.channelThreads.agentId, agentId)));
  const turn = row ?? null;
  turns.set(agentId, turn);
  return turn;
}

export function currentTurn(agentId: string) {
  return turns.get(agentId) ?? null;
}

export function outsiderTurn(agentId: string) {
  const turn = turns.get(agentId);
  return Boolean(turn && !turn.trusted);
}

export function forgetTurn(agentId: string) {
  turns.delete(agentId);
}
