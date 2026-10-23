import { and, desc, eq, gte, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { pastCeiling } from "@/lib/agent-talk";
import { getDb, schema } from "@/lib/db";
import type { AgentMessageKind } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { newId } from "@/lib/ids";
import { relayGist, type RoomRelay } from "@/lib/rooms";
import type { Hub } from "./hub";
import { turnRunId } from "./followups";
import { pairStopped } from "./pair-threads";
import { teamGroupsOf, type TeamGroup } from "./room-store";

export const TALK_KINDS: AgentMessageKind[] = ["message", "handoff"];

export const TEAM_LIMITS = { conversationWindowMs: 30 * 60 * 1000 } as const;

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

type AgentRow = typeof schema.agents.$inferSelect;

export type TeamTool = {
  name: string;
  description: string;
  schema: z.ZodType;
  run: (args: never) => Promise<ToolResult>;
};

export type Teammate = { id: string; name: string; role: string; tasks: { id: string; title: string }[]; groups: TeamGroup[] };

export const NO_GROUP = "none";

const reply = (text: string, isError = false): ToolResult => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

export function limitRefusal(input: { depth: number; ceiling: number | null; stopped: boolean; teammate: string }): string | null {
  if (input.stopped) {
    return `refused: your owner stopped the conversation between you and ${input.teammate}; do not message them again until your owner lets you, and tell your owner what is left.`;
  }
  if (pastCeiling(input.depth, input.ceiling)) {
    return `refused: this conversation between agents is already ${input.ceiling} messages deep, the most this server allows; stop here and tell your owner what is left.`;
  }
  return null;
}

export function pickTeammate<T extends { id: string; name: string }>(teammates: T[], wanted: string): T | null {
  const key = wanted.trim().toLowerCase();
  return teammates.find((mate) => mate.id === wanted.trim()) ?? teammates.find((mate) => mate.name.trim().toLowerCase() === key) ?? null;
}

export function pickTask(tasks: { id: string; title: string }[], wanted: string): { id: string; title: string } | null {
  const key = wanted.trim().toLowerCase();
  return tasks.find((task) => task.id === wanted.trim()) ?? tasks.find((task) => task.title.trim().toLowerCase() === key) ?? null;
}

export function pickGroup<T extends { id: string; name: string }>(groups: T[], wanted: string): T | null {
  const key = wanted.trim().toLowerCase();
  return groups.find((group) => group.id === wanted.trim()) ?? groups.find((group) => group.name.trim().toLowerCase() === key) ?? null;
}

export function groupRefusal(teammate: string, wanted: string, groups: { id: string; name: string }[]): string {
  const valid = groups.map((group) => `"${group.name}" (${group.id})`);
  return groups.length
    ? `no team group "${wanted}" you can post to with ${teammate}; use one of: ${valid.join(", ")}, or "${NO_GROUP}" to post in no group`
    : `you share no team group with ${teammate} you can post to here; leave group out or use "${NO_GROUP}"`;
}

export async function listTeammates(agent: Pick<AgentRow, "id" | "ownerId">): Promise<Teammate[]> {
  const db = getDb();
  const agents = await db
    .select({ id: schema.agents.id, name: schema.agents.name, role: schema.agents.role })
    .from(schema.agents)
    .where(and(ne(schema.agents.id, agent.id), eq(schema.agents.ownerId, agent.ownerId)));
  if (!agents.length) return [];
  const groups = await teamGroupsOf(agent.id);
  const recipes = await db
    .select({ id: schema.recipes.id, agentId: schema.recipes.agentId, recipe: schema.recipes.recipe })
    .from(schema.recipes)
    .where(inArray(schema.recipes.agentId, agents.map((row) => row.id)));
  return agents.map((row) => ({
    id: row.id,
    name: row.name,
    role: row.role ?? "",
    tasks: recipes.filter((recipe) => recipe.agentId === row.id).map((recipe) => ({ id: recipe.id, title: recipe.recipe.title })),
    groups: groups.filter((group) => group.agentIds.includes(row.id)).map((group) => ({ id: group.id, name: group.name, language: group.language })),
  }));
}

export async function conversationDepth(agentId: string, now = Date.now()): Promise<number> {
  const [latest] = await getDb()
    .select({ depth: schema.agentMessages.depth })
    .from(schema.agentMessages)
    .where(and(eq(schema.agentMessages.toAgentId, agentId), inArray(schema.agentMessages.kind, TALK_KINDS), gte(schema.agentMessages.createdAt, new Date(now - TEAM_LIMITS.conversationWindowMs))))
    .orderBy(desc(schema.agentMessages.createdAt))
    .limit(1);
  return (latest?.depth ?? 0) + 1;
}

export function teamTools(hub: Hub, agent: AgentRow): TeamTool[] {
  const guard = async (to: Teammate) => {
    const depth = await conversationDepth(agent.id);
    const refusal = limitRefusal({ depth, ceiling: env.agentTalkCeiling, stopped: await pairStopped(agent.id, to.id), teammate: to.name });
    return { depth, refusal };
  };

  const taskGroup = async () => {
    const runId = await turnRunId(agent.id, async () => null);
    if (!runId) return null;
    const [row] = await getDb()
      .select({ roomId: schema.recipes.roomId })
      .from(schema.runs)
      .innerJoin(schema.recipes, eq(schema.recipes.id, schema.runs.recipeId))
      .where(and(eq(schema.runs.id, runId), eq(schema.runs.agentId, agent.id)));
    return row?.roomId ?? null;
  };

  type Place = { target?: string; skip?: true } | { error: string };
  const place = async (to: Teammate, wanted: string | undefined): Promise<Place> => {
    const current = hub.turnRoom(agent.id);
    const choices = current ? to.groups.filter((group) => group.id === current) : to.groups;
    const fixed = current ? null : await taskGroup();
    if (fixed && to.groups.some((group) => group.id === fixed)) return { target: fixed };
    if (wanted === undefined || !wanted.trim()) return {};
    if (wanted.trim().toLowerCase() === NO_GROUP) return { skip: true };
    const group = pickGroup(choices, wanted);
    return group ? { target: group.id } : { error: groupRefusal(to.name, wanted, choices) };
  };

  const relayRoom = async (to: Teammate, where: Place) => {
    if ("error" in where || where.skip) return null;
    const ownRun = await turnRunId(agent.id, async () => null);
    if (!ownRun && !hub.turnRoom(agent.id)) return null;
    const room = await hub.rooms.teamworkRoom(agent.id, to.id, where.target).catch((error) => {
      console.log(JSON.stringify({ event: "room_relay_error", agentId: agent.id, error: String(error) }));
      return null;
    });
    return room ? { ...room, ownRun } : null;
  };

  type RelayRoom = Awaited<ReturnType<typeof relayRoom>>;
  const relay = async (to: Teammate, room: RelayRoom, relayOf: (line: string) => RoomRelay, raw: { note?: string; body: string }, runId: string | null) => {
    if (!room) return;
    const line = relayGist(raw.note?.trim() || raw.body);
    if (!line) return;
    await hub.rooms.relayTeamwork(agent.id, to.id, room.id, relayOf(line), runId ?? room.ownRun).catch((error) => console.log(JSON.stringify({ event: "room_relay_error", agentId: agent.id, error: String(error) })));
  };
  const note = z.string().max(300).optional().describe("One short line for the team group you share with them, if any, written for the people reading it, in that group's language from list_teammates (for example: sweep for the week is ready, 2 changes and 8 with no news). Leave it out and the first words of your text are used.");
  const group = z
    .string()
    .max(200)
    .optional()
    .describe(
      `Which team group you share with them shows that line: its id or exact name from list_teammates. Pick the group whose subject matches this work. "${NO_GROUP}" posts in no group. Leave it out and it goes to the shared group with the latest activity. If your task has a group of its own, that one is used.`,
    );

  return [
    {
      name: "list_teammates",
      description:
        "List the other understudies you may work with (same owner, or shared with your owner), with their role, the tasks they know and the team groups you share with them (id and name), where the people of the team see your hand-offs and messages to them.",
      schema: z.object({}),
      run: (async () => {
        const mates = await listTeammates(agent);
        if (!mates.length) return reply("You have no teammates yet.");
        return reply(JSON.stringify(mates.map((mate) => ({ name: mate.name, role: mate.role, tasks: mate.tasks.map((task) => task.title), groups: mate.groups }))));
      }) as TeamTool["run"],
    },
    {
      name: "message_agent",
      description: "Send a short message to a teammate (by name). It reaches them as a chat turn marked as coming from you. Use it to ask or tell them something the work needs; keep it brief.",
      schema: z.object({ agent: z.string().min(1).max(200), text: z.string().min(1).max(2000), note, group }),
      run: (async (args: { agent: string; text: string; note?: string; group?: string }) => {
        const to = pickTeammate(await listTeammates(agent), args.agent);
        if (!to) return reply(`unknown teammate "${args.agent}"; call list_teammates`, true);
        const where = await place(to, args.group);
        if ("error" in where) return reply(where.error, true);
        const { depth, refusal } = await guard(to);
        if (refusal) return reply(refusal, true);
        const delivered = (await hub.deliver(to.id, { type: "chat", text: args.text, from: agent.name, fromAgent: { id: agent.id, name: agent.name } }, { source: "team" })).status === "sent";
        await getDb()
          .insert(schema.agentMessages)
          .values({ id: newId("amsg"), fromAgentId: agent.id, toAgentId: to.id, kind: "message", text: args.text, depth, delivered, audienceId: hub.turnAudience(agent.id) });
        await hub.addMessage(to.id, "system", `${agent.name}: ${args.text}`, null, undefined, undefined, undefined, undefined, undefined, undefined, hub.turnAudience(agent.id));
        await relay(to, await relayRoom(to, where), (line) => ({ kind: "message", to: to.name, line }), { note: args.note, body: args.text }, null);
        return reply(delivered ? `delivered to ${to.name}` : `${to.name}'s computer is reconnecting; the message is queued and reaches them as soon as it is back (up to 30 minutes)`);
      }) as TeamTool["run"],
    },
    {
      name: "hand_off",
      description:
        "Start one of a teammate's own tasks (by its title, see list_teammates) with some input for it. The input reaches them as quoted data, and their owner still approves anything irreversible. During a task, if you share a team group with them, the people there see a short line about it and its result; choose that group with group.",
      schema: z.object({ agent: z.string().min(1).max(200), task: z.string().min(1).max(300), input: z.string().max(20000), note, group }),
      run: (async (args: { agent: string; task: string; input: string; note?: string; group?: string }) => {
        const to = pickTeammate(await listTeammates(agent), args.agent);
        if (!to) return reply(`unknown teammate "${args.agent}"; call list_teammates`, true);
        const task = pickTask(to.tasks, args.task);
        if (!task) return reply(`${to.name} has no task called "${args.task}"; their tasks: ${to.tasks.map((t) => t.title).join(", ") || "none"}`, true);
        const where = await place(to, args.group);
        if ("error" in where) return reply(where.error, true);
        const { depth, refusal } = await guard(to);
        if (refusal) return reply(refusal, true);
        const room = await relayRoom(to, where);
        const started = await hub.startRun(task.id, "handoff", { input: `From ${agent.name}: ${args.input}`, ...(room && room.locale !== "en" ? { group: { name: room.name, locale: room.locale } } : {}) });
        const runId = "runId" in started ? (started.runId as string | undefined) : undefined;
        await getDb()
          .insert(schema.agentMessages)
          .values({ id: newId("amsg"), fromAgentId: agent.id, toAgentId: to.id, kind: "handoff", text: args.input, task: task.title, runId: runId ?? null, depth, delivered: started.ok, audienceId: hub.turnAudience(agent.id) });
        if (started.ok && runId) await relay(to, room, (line) => ({ kind: "handoff", to: to.name, task: task.title, line }), { note: args.note, body: args.input }, runId);
        return reply(started.ok ? `${to.name} started "${task.title}"` : `could not start "${task.title}" for ${to.name}: ${"reason" in started ? started.reason : "unknown"}`, !started.ok);
      }) as TeamTool["run"],
    },
  ];
}
