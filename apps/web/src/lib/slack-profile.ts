import { featuredFor } from "@/lib/connector-showcase";
import type { AgentTools } from "@/lib/db/schema";
import { isReadOnly, type ConnectorCeiling, type ToolInfo, type ToolPermission } from "@/lib/tool-policy";

export type SlackProfileMode = NonNullable<AgentTools["slackProfileMode"]>;

export function isSlackProfile(url: string) {
  return featuredFor(url)?.id === "slack";
}

export function slackProfileMode(tools: Pick<AgentTools, "slackProfileMode"> | null | undefined): SlackProfileMode {
  return tools?.slackProfileMode === "free" ? "free" : "ask";
}

export function ceilingForAgent(ceiling: ConnectorCeiling, url: string, tools: Pick<AgentTools, "slackProfileMode"> | null | undefined): ConnectorCeiling {
  return isSlackProfile(url) && slackProfileMode(tools) === "free" ? { ...ceiling, askWrites: false } : ceiling;
}

export function slackPosting(tools: ToolInfo[] | null | undefined, policy: Record<string, ToolPermission> | undefined, saved: SlackProfileMode): { mode: SlackProfileMode; shown?: SlackProfileMode } {
  const writes = (tools ?? []).filter((tool) => !isReadOnly(tool.annotations));
  if (writes.length === 0) return { mode: saved, shown: saved };
  const allowed = writes.filter((tool) => policy?.[tool.name] === "allow").length;
  return { mode: allowed > 0 ? "free" : "ask", shown: allowed === 0 ? "ask" : allowed === writes.length ? "free" : undefined };
}
