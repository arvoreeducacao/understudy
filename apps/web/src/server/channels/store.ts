import { and, eq, gt, isNotNull, lt, sql } from "drizzle-orm";
import { getDb, getPool, schema } from "@/lib/db";
import type { ChannelKind, PendingFile } from "@/lib/db/schema";

export const ROUTE_WINDOW_MS = 30 * 60 * 1000;
export const MAX_PENDING_CHARS = 60_000;
export const MAX_PENDING_FILES = 10;

export type AgentChannel = typeof schema.agentChannels.$inferSelect;
export type ChannelThread = typeof schema.channelThreads.$inferSelect;

export type ChannelOwner = { id: string; name: string; email: string };

export type AddressedChannel = { channel: AgentChannel; agentName: string; owner: ChannelOwner };

export async function channelByAddress(kind: ChannelKind, address: string): Promise<AddressedChannel | null> {
  const [row] = await getDb()
    .select({ channel: schema.agentChannels, agentName: schema.agents.name, ownerId: schema.user.id, ownerName: schema.user.name, ownerEmail: schema.user.email })
    .from(schema.agentChannels)
    .innerJoin(schema.agents, eq(schema.agents.id, schema.agentChannels.agentId))
    .innerJoin(schema.user, eq(schema.user.id, schema.agents.ownerId))
    .where(and(eq(schema.agentChannels.kind, kind), eq(schema.agentChannels.address, address)));
  if (!row) return null;
  return { channel: row.channel, agentName: row.agentName, owner: { id: row.ownerId, name: row.ownerName, email: row.ownerEmail } };
}

export async function agentChannel(agentId: string, kind: ChannelKind) {
  const [row] = await getDb()
    .select()
    .from(schema.agentChannels)
    .where(and(eq(schema.agentChannels.agentId, agentId), eq(schema.agentChannels.kind, kind)));
  return row ?? null;
}

export async function setRoute(agentId: string, threadId: string, now = new Date()) {
  const expiresAt = new Date(now.getTime() + ROUTE_WINDOW_MS);
  const db = getDb();
  await db
    .insert(schema.channelRoutes)
    .values({ agentId, threadId, expiresAt, updatedAt: now })
    .onConflictDoUpdate({ target: schema.channelRoutes.agentId, set: { threadId, expiresAt, updatedAt: now } });
  await db.update(schema.slackThreads).set({ expiresAt: now }).where(and(eq(schema.slackThreads.agentId, agentId), gt(schema.slackThreads.expiresAt, now)));
}

export async function routeIfTrusted(agentId: string, threadId: string) {
  const [thread] = await getDb()
    .select({ trusted: schema.channelThreads.trusted })
    .from(schema.channelThreads)
    .where(and(eq(schema.channelThreads.id, threadId), eq(schema.channelThreads.agentId, agentId)));
  if (thread?.trusted) await setRoute(agentId, threadId);
}

export async function clearRoute(agentId: string) {
  await getDb().delete(schema.channelRoutes).where(eq(schema.channelRoutes.agentId, agentId));
}

export type ActiveRoute = { threadId: string; kind: ChannelKind; updatedAt: Date };

export async function activeRoute(agentId: string, now = new Date()): Promise<ActiveRoute | null> {
  const [row] = await getDb()
    .select({ threadId: schema.channelRoutes.threadId, updatedAt: schema.channelRoutes.updatedAt, kind: schema.agentChannels.kind })
    .from(schema.channelRoutes)
    .innerJoin(schema.channelThreads, eq(schema.channelThreads.id, schema.channelRoutes.threadId))
    .innerJoin(schema.agentChannels, eq(schema.agentChannels.id, schema.channelThreads.channelId))
    .where(and(eq(schema.channelRoutes.agentId, agentId), gt(schema.channelRoutes.expiresAt, now)));
  return row ?? null;
}

export async function appendPending(threadId: string, input: { text?: string; file?: PendingFile }, now = new Date()) {
  const text = input.text?.trim() ?? "";
  const file = input.file ? JSON.stringify([input.file]) : "[]";
  await getPool().query(
    `update channel_threads
        set pending_text = left(case when $2 = '' then pending_text when pending_text = '' then $2 else pending_text || E'\\n\\n' || $2 end, $5),
            pending_files = case when jsonb_array_length(pending_files) >= $6 then pending_files else pending_files || $3::jsonb end,
            pending_since = coalesce(pending_since, $4),
            updated_at = $4
      where id = $1`,
    [threadId, text, file, now, MAX_PENDING_CHARS, MAX_PENDING_FILES],
  );
}

export type TakenReply = { thread: ChannelThread; channel: AgentChannel; text: string; files: PendingFile[] };

export async function takePending(threadId: string): Promise<TakenReply | null> {
  const { rows } = await getPool().query<{ pending_text: string; pending_files: PendingFile[] }>(
    `with old as (
        select id, pending_text, pending_files from channel_threads where id = $1 and pending_since is not null for update
     )
     update channel_threads t
        set pending_text = '', pending_files = '[]'::jsonb, pending_since = null
       from old
      where t.id = old.id
     returning old.pending_text, old.pending_files`,
    [threadId],
  );
  const taken = rows[0];
  if (!taken) return null;
  const [row] = await getDb()
    .select({ thread: schema.channelThreads, channel: schema.agentChannels })
    .from(schema.channelThreads)
    .innerJoin(schema.agentChannels, eq(schema.agentChannels.id, schema.channelThreads.channelId))
    .where(eq(schema.channelThreads.id, threadId));
  if (!row) return null;
  return { ...row, text: taken.pending_text, files: taken.pending_files ?? [] };
}

export async function pendingThreads(agentId: string) {
  const rows = await getDb()
    .select({ id: schema.channelThreads.id })
    .from(schema.channelThreads)
    .where(and(eq(schema.channelThreads.agentId, agentId), isNotNull(schema.channelThreads.pendingSince)));
  return rows.map((row) => row.id);
}

export async function stalePendingThreads(olderThan: Date) {
  const rows = await getDb()
    .select({ id: schema.channelThreads.id, agentId: schema.channelThreads.agentId })
    .from(schema.channelThreads)
    .where(lt(schema.channelThreads.pendingSince, olderThan))
    .limit(50);
  return rows;
}

export async function recordSent(threadId: string, messageId: string, references: string[]) {
  await getDb()
    .update(schema.channelThreads)
    .set({ lastMessageId: messageId, references: references.slice(-20).join(" "), updatedAt: sql`now()` })
    .where(eq(schema.channelThreads.id, threadId));
}

const LIST_OF = "case when jsonb_typeof(settings -> $2) = 'array' then settings -> $2 else '[]'::jsonb end";

export async function appendChannelList(channelId: string, key: string, item: Record<string, unknown>, max: number, uniqueBy?: string) {
  const unique = uniqueBy ? ` and not exists (select 1 from jsonb_array_elements(${LIST_OF}) as taken(e) where taken.e ->> $5 = $3::jsonb ->> $5)` : "";
  const result = await getPool().query(
    `update agent_channels set settings = jsonb_set(settings, array[$2::text], (
       select coalesce(jsonb_agg(e order by n), '[]'::jsonb) from (
         select e, n from jsonb_array_elements(${LIST_OF} || jsonb_build_array($3::jsonb)) with ordinality as t(e, n) order by n desc limit $4
       ) kept
     ), true), updated_at = now() where id = $1${unique}`,
    uniqueBy ? [channelId, key, JSON.stringify(item), max, uniqueBy] : [channelId, key, JSON.stringify(item), max],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function dropFromChannelList(channelId: string, key: string, id: string) {
  await getPool().query(
    `update agent_channels set settings = jsonb_set(settings, array[$2::text], (
       select coalesce(jsonb_agg(e order by n), '[]'::jsonb) from jsonb_array_elements(${LIST_OF}) with ordinality as t(e, n) where e ->> 'id' is distinct from $3
     ), true), updated_at = now() where id = $1`,
    [channelId, key, id],
  );
}

export async function dropFromAgentChannelLists(agentId: string, key: string, id: string) {
  await getPool().query(
    `update agent_channels set settings = jsonb_set(settings, array[$2::text], (
       select coalesce(jsonb_agg(e order by n), '[]'::jsonb) from jsonb_array_elements(${LIST_OF}) with ordinality as t(e, n) where e ->> 'id' is distinct from $3
     ), true), updated_at = now() where agent_id = $1 and exists (select 1 from jsonb_array_elements(${LIST_OF}) as listed(e) where listed.e ->> 'id' = $3)`,
    [agentId, key, id],
  );
}

export async function mergeChannelSettings(channelId: string, patch: Record<string, unknown>, remove: string[] = []) {
  await getPool().query(
    "update agent_channels set settings = (settings - $3::text[]) || $2::jsonb, updated_at = now() where id = $1",
    [channelId, JSON.stringify(patch), remove],
  );
}
