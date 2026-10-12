import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import type { AgentTools } from "@/lib/db/schema";
import { cleanLook } from "@/lib/look";
import { messages } from "@/lib/messages";
import { requireUser } from "@/lib/session";
import { serverAllowedFor } from "@/server/approval-payload";
import { cleanPolicy, cleanSeenHints } from "@/lib/tool-policy";

export async function toolsFrom(form: FormData, email: string): Promise<AgentTools> {
  const requested = new Set(form.getAll("servers").map(String).slice(0, 50));
  const usable = (await getDb().select({ id: schema.mcpServers.id, allowedEmails: schema.mcpServers.allowedEmails }).from(schema.mcpServers))
    .filter((server) => serverAllowedFor(server.allowedEmails, email))
    .map((server) => server.id);
  const allowed = usable.filter((id) => requested.has(id));
  return {
    notifyOwner: form.get("notifyOwner") === "on",
    slack: false,
    slackChannels: [],
    slackMode: slackModeFrom(form.get("slackMode")),
    servers: allowed,
    askTools: [],
    toolPolicy: cleanPolicy(parsePolicy(form.get("toolPolicy")), usable),
    toolHints: cleanSeenHints(parsePolicy(form.get("toolHints")), usable),
  };
}

function parsePolicy(value: FormDataEntryValue | null) {
  if (typeof value !== "string" || value.length > 200_000) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function slackModeFrom(value: FormDataEntryValue | null): AgentTools["slackMode"] {
  return value === "off" || value === "free" ? value : "ask";
}

export function parseLook(form: FormData) {
  try {
    return cleanLook(JSON.parse(String(form.get("look") ?? "{}")));
  } catch {
    return cleanLook(null);
  }
}

export async function ownAgent(agentId: string) {
  const user = await requireUser();
  const [agent] = await getDb()
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.id, agentId), eq(schema.agents.ownerId, user.id)));
  if (!agent) throw new Error(messages.common.notFound);
  return { user, agent };
}

export async function ownRecipe(recipeId: string) {
  const user = await requireUser();
  const [row] = await getDb()
    .select({ recipe: schema.recipes, agent: schema.agents })
    .from(schema.recipes)
    .innerJoin(schema.agents, eq(schema.agents.id, schema.recipes.agentId))
    .where(and(eq(schema.recipes.id, recipeId), eq(schema.agents.ownerId, user.id)));
  if (!row) throw new Error(messages.common.notFound);
  return { user, ...row };
}
