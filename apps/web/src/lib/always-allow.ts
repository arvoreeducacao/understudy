import { allowedHost, allowedTool, type ApprovalAllow } from "@understudy/protocol";
import type { ApprovalGrant } from "@/lib/db/schema";

export type AlwaysAllow = { tool: string } | { host: string };

export function alwaysAllowOf(grant: ApprovalGrant | null | undefined): AlwaysAllow | undefined {
  if (!grant) return undefined;
  if ("host" in grant) return { host: grant.host };
  if ("gatekeeperTool" in grant) return { tool: grant.gatekeeperTool };
  return { tool: grant.tool };
}

export function allowEntryOf(grant: ApprovalGrant): ApprovalAllow | null {
  if ("host" in grant) {
    const host = allowedHost(grant.host);
    return host ? { kind: "host", value: host } : null;
  }
  if ("gatekeeperTool" in grant) {
    const tool = allowedTool(grant.gatekeeperTool);
    return tool ? { kind: "tool", value: tool } : null;
  }
  return null;
}

export function alwaysAllowTarget(allow: AlwaysAllow) {
  return "host" in allow ? allow.host : allow.tool;
}

type AlwaysAllowCopy = {
  approveAlwaysOn: (host: string) => string;
  approveAlwaysOnHint: (host: string) => string;
  approveAlwaysTool: (tool: string) => string;
  approveAlwaysHint: (tool: string) => string;
};

export function alwaysAllowCopy(allow: AlwaysAllow, copy: AlwaysAllowCopy) {
  return "host" in allow ? { label: copy.approveAlwaysOn(allow.host), hint: copy.approveAlwaysOnHint(allow.host) } : { label: copy.approveAlwaysTool(allow.tool), hint: copy.approveAlwaysHint(allow.tool) };
}
