export type ToolPermission = "allow" | "ask" | "never";

export type ToolHints = { readOnlyHint?: boolean; destructiveHint?: boolean };

export type ToolInfo = { name: string; description?: string; annotations?: ToolHints };

export type ConnectorCeiling = { askAll?: boolean; askTools?: string[] | null; neverTools?: string[] | null };

export type ToolPolicy = Record<string, Record<string, ToolPermission>>;

export type ToolVerdict = "allowed" | "approved" | "denied" | "blocked";

const RANK: Record<ToolPermission, number> = { allow: 0, ask: 1, never: 2 };

export const PERMISSIONS: ToolPermission[] = ["allow", "ask", "never"];

const MAX_TOOL_NAME = 200;
const MAX_TOOLS_PER_SERVER = 500;
const MAX_SERVERS = 50;

export function isPermission(value: unknown): value is ToolPermission {
  return value === "allow" || value === "ask" || value === "never";
}

export function isReadOnly(hints: ToolHints | undefined) {
  return hints?.readOnlyHint === true && hints.destructiveHint !== true;
}

export function isDestructive(hints: ToolHints | undefined) {
  return !isReadOnly(hints) && hints?.destructiveHint === true;
}

export function defaultPermission(hints: ToolHints | undefined): ToolPermission {
  return isReadOnly(hints) ? "allow" : "ask";
}

export function stricter(a: ToolPermission, b: ToolPermission): ToolPermission {
  return RANK[a] >= RANK[b] ? a : b;
}

export function ceilingFor(server: ConnectorCeiling, tool: string): ToolPermission {
  if ((server.neverTools ?? []).includes(tool)) return "never";
  if (server.askAll || (server.askTools ?? []).includes(tool)) return "ask";
  return "allow";
}

export function allowedChoices(ceiling: ToolPermission) {
  return PERMISSIONS.filter((permission) => RANK[permission] >= RANK[ceiling]);
}

export function ownerChoice(policy: ToolPolicy | undefined, legacyAsk: string[] | undefined, serverId: string, tool: string): ToolPermission | undefined {
  const chosen = policy?.[serverId]?.[tool];
  if (isPermission(chosen)) return chosen;
  if ((legacyAsk ?? []).includes(`${serverId}:${tool}`)) return "ask";
  return undefined;
}

export function effectivePermission(input: {
  serverId: string;
  server: ConnectorCeiling;
  tool: ToolInfo;
  policy?: ToolPolicy;
  legacyAsk?: string[];
}): { permission: ToolPermission; source: "admin" | "owner" | "default" } {
  const ceiling = ceilingFor(input.server, input.tool.name);
  const chosen = ownerChoice(input.policy, input.legacyAsk, input.serverId, input.tool.name);
  const wanted = chosen ?? defaultPermission(input.tool.annotations);
  const permission = stricter(wanted, ceiling);
  const source = permission !== wanted ? "admin" : chosen ? "owner" : "default";
  return { permission, source };
}

export function canAlwaysAllow(server: ConnectorCeiling, tool: string) {
  return ceilingFor(server, tool) === "allow";
}

export function withChoice(policy: Record<string, ToolPermission>, tool: ToolInfo, permission: ToolPermission) {
  const next = { ...policy };
  if (permission === defaultPermission(tool.annotations)) delete next[tool.name];
  else next[tool.name] = permission;
  return next;
}

export function allowReadOnly(policy: Record<string, ToolPermission>, tools: ToolInfo[]) {
  let next = { ...policy };
  for (const tool of tools) if (isReadOnly(tool.annotations)) next = withChoice(next, tool, "allow");
  return next;
}

export function askForRest(policy: Record<string, ToolPermission>, tools: ToolInfo[]) {
  let next = { ...policy };
  for (const tool of tools) if (!isReadOnly(tool.annotations)) next = withChoice(next, tool, "ask");
  return next;
}

export function cleanPolicy(input: unknown, serverIds: string[]): ToolPolicy {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const allowed = new Set(serverIds);
  const clean: ToolPolicy = {};
  for (const [serverId, tools] of Object.entries(input as Record<string, unknown>)) {
    if (Object.keys(clean).length >= MAX_SERVERS) break;
    if (!allowed.has(serverId) || !tools || typeof tools !== "object" || Array.isArray(tools)) continue;
    const entries = Object.entries(tools as Record<string, unknown>)
      .filter(([name, permission]) => name.length > 0 && name.length <= MAX_TOOL_NAME && isPermission(permission))
      .slice(0, MAX_TOOLS_PER_SERVER) as [string, ToolPermission][];
    if (entries.length) clean[serverId] = Object.fromEntries(entries);
  }
  return clean;
}

export function cleanToolNames(input: unknown) {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.map(String).filter((name) => name.length > 0 && name.length <= MAX_TOOL_NAME))].slice(0, MAX_TOOLS_PER_SERVER);
}

export function withLegacyAsks(policy: ToolPolicy | undefined, legacyAsk: string[] | undefined): ToolPolicy {
  const merged: ToolPolicy = Object.fromEntries(Object.entries(policy ?? {}).map(([serverId, tools]) => [serverId, { ...tools }]));
  for (const entry of legacyAsk ?? []) {
    const split = entry.indexOf(":");
    if (split <= 0) continue;
    const serverId = entry.slice(0, split);
    const tool = entry.slice(split + 1);
    if (!tool || merged[serverId]?.[tool]) continue;
    merged[serverId] = { ...(merged[serverId] ?? {}), [tool]: "ask" };
  }
  return merged;
}

export function grantedPolicy(policy: ToolPolicy | undefined, serverId: string, tool: string): ToolPolicy {
  return { ...(policy ?? {}), [serverId]: { ...(policy?.[serverId] ?? {}), [tool]: "allow" } };
}

export function oneLine(text: string | undefined, max = 280) {
  const line = (text ?? "").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}
