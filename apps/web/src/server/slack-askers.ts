import { createHash } from "node:crypto";
import { and, desc, eq, gt, isNotNull, lt, sql } from "drizzle-orm";
import { agentAccess, canChat } from "@/lib/access";
import { getDb, schema } from "@/lib/db";
import { agentIdentity } from "./slack";
import { postAgentText } from "./slack-threads";

export const ASKER_THREAD_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const ORIGIN_PREFIX = "sat_";

export type SlackAgent = { id: string; name: string; ownerId: string };

type AskerTurn = { channel: string; threadTs: string | null; guest: boolean };

const turns = new Map<string, AskerTurn>();

export async function slackAgentsFor(userId: string): Promise<SlackAgent[]> {
  const db = getDb();
  const columns = { id: schema.agents.id, name: schema.agents.name, ownerId: schema.agents.ownerId };
  const [owned, teams, open] = await Promise.all([
    db.select(columns).from(schema.agents).where(eq(schema.agents.ownerId, userId)),
    db
      .select(columns)
      .from(schema.agents)
      .innerJoin(schema.teamMembers, and(eq(schema.teamMembers.teamId, schema.agents.teamId), eq(schema.teamMembers.userId, userId))),
    db
      .select(columns)
      .from(schema.agents)
      .where(and(isNotNull(schema.agents.teamId), sql`(${schema.agents.tools} ->> 'slackAnyone') = 'true'`)),
  ]);
  const seen = new Map<string, SlackAgent>();
  for (const agent of [...owned, ...teams, ...open]) if (!seen.has(agent.id)) seen.set(agent.id, agent);
  return [...seen.values()];
}

export function askerThreadId(input: { agentId: string; askedBy: string; channel: string; threadTs?: string | null }) {
  const key = [input.agentId, input.askedBy, input.channel, input.threadTs ?? ""].join("\n");
  return `${ORIGIN_PREFIX}${createHash("sha256").update(key).digest("base64url").slice(0, 32)}`;
}

export async function rememberAskerThread(input: { agentId: string; askedBy: string; channel: string; threadTs?: string; slackUser: string }, now = new Date()) {
  const id = askerThreadId(input);
  const expiresAt = new Date(now.getTime() + ASKER_THREAD_WINDOW_MS);
  const db = getDb();
  await db.delete(schema.slackAskerThreads).where(lt(schema.slackAskerThreads.expiresAt, now));
  await db
    .insert(schema.slackAskerThreads)
    .values({ id, agentId: input.agentId, askedBy: input.askedBy, channel: input.channel, threadTs: input.threadTs ?? null, slackUser: input.slackUser, expiresAt, updatedAt: now })
    .onConflictDoUpdate({ target: schema.slackAskerThreads.id, set: { slackUser: input.slackUser, expiresAt, updatedAt: now } });
  return id;
}

export async function agentForAskerThread(channel: string, threadTs: string | undefined, now = new Date()) {
  if (!threadTs) return null;
  const [row] = await getDb()
    .select({ agentId: schema.slackAskerThreads.agentId })
    .from(schema.slackAskerThreads)
    .where(and(eq(schema.slackAskerThreads.channel, channel), eq(schema.slackAskerThreads.threadTs, threadTs), gt(schema.slackAskerThreads.expiresAt, now)))
    .orderBy(desc(schema.slackAskerThreads.updatedAt))
    .limit(1);
  return row?.agentId ?? null;
}

export async function startAskerTurn(agentId: string, origin: string | undefined, audience: string | null) {
  turns.delete(agentId);
  if (!origin?.startsWith(ORIGIN_PREFIX) || !audience) return null;
  const [row] = await getDb()
    .select()
    .from(schema.slackAskerThreads)
    .where(and(eq(schema.slackAskerThreads.id, origin), eq(schema.slackAskerThreads.agentId, agentId), eq(schema.slackAskerThreads.askedBy, audience)));
  if (!row) return null;
  const current: AskerTurn = { channel: row.channel, threadTs: row.threadTs, guest: !canChat(await agentAccess(row.askedBy, agentId)) };
  turns.set(agentId, current);
  return current;
}

export function askerTurn(agentId: string) {
  return turns.get(agentId) ?? null;
}

export function guestTurn(agentId: string) {
  return turns.get(agentId)?.guest ?? false;
}

export function forgetAskerTurn(agentId: string) {
  turns.delete(agentId);
}

export async function replyToAsker(agentId: string, turn: AskerTurn, text: string) {
  const [agent] = await getDb().select({ id: schema.agents.id, name: schema.agents.name }).from(schema.agents).where(eq(schema.agents.id, agentId));
  if (!agent || !text.trim()) return;
  await postAgentText({ channel: turn.channel, threadTs: turn.threadTs ?? undefined, text, as: agentIdentity(agent) });
}

