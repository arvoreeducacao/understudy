import { featuredFor } from "@/lib/connector-showcase";
import type { AgentTools } from "@/lib/db/schema";
import type { ConnectorCeiling } from "@/lib/tool-policy";

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
