export type ToolPermission = "allow" | "ask" | "never";

export type ToolHints = { readOnlyHint?: boolean; destructiveHint?: boolean };

export type ToolInfo = { name: string; description?: string; annotations?: ToolHints };

export type ConnectorCeiling = { askAll?: boolean; askTools?: string[] | null; neverTools?: string[] | null; askWrites?: boolean };

export type ToolPolicy = Record<string, Record<string, ToolPermission>>;

export type SeenHints = Record<string, Record<string, ToolHints>>;

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

export function toolKey(name: string) {
  return name.normalize("NFKC").trim().toLowerCase();
}

const INVISIBLE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0]/g;

const LOOKALIKES: Record<string, string> = {
  а: "a", в: "b", е: "e", ё: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x", ѕ: "s", і: "i", ї: "i", ј: "j", ԁ: "d", ԛ: "q", ԝ: "w", һ: "h", ӏ: "l", ɡ: "g",
  α: "a", β: "b", ε: "e", η: "n", ι: "i", κ: "k", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x", ω: "w", ϲ: "c", ϳ: "j",
  ı: "i", ȷ: "j", ℓ: "l", "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "−": "-", "＿": "_",
};

export function toolSkeleton(name: string) {
  return [...toolKey(name).replace(INVISIBLE, "")].map((char) => LOOKALIKES[char] ?? char).join("");
}

export function plainToolName(name: string) {
  return /^[\x21-\x7e]+$/.test(name.trim());
}

function lookup<T>(entries: Record<string, T> | undefined, tool: string): T[] {
  if (!entries) return [];
  const key = toolKey(tool);
  return Object.entries(entries)
    .filter(([name]) => toolKey(name) === key)
    .map(([, value]) => value);
}

export function hintsLoosened(seen: ToolHints | undefined, current: ToolHints | undefined) {
  if (!seen) return false;
  return (isReadOnly(current) && !isReadOnly(seen)) || (isDestructive(seen) && !isDestructive(current));
}

export function hintsTightened(seen: ToolHints | undefined, current: ToolHints | undefined) {
  if (!seen) return false;
  return (isReadOnly(seen) && !isReadOnly(current)) || (!isDestructive(seen) && isDestructive(current));
}

export function hintsRecordedFor(seen: SeenHints | undefined, serverId: string) {
  return Object.keys(seen?.[serverId] ?? {}).length > 0;
}

export function trustedHints(seen: ToolHints | undefined, current: ToolHints | undefined): ToolHints | undefined {
  if (!hintsLoosened(seen, current)) return current;
  return { readOnlyHint: isReadOnly(seen) && isReadOnly(current), destructiveHint: isDestructive(seen) || isDestructive(current) };
}

export function seenHintsFor(seen: SeenHints | undefined, serverId: string, tool: string): ToolHints | undefined {
  const found = lookup(seen?.[serverId], tool);
  if (found.length === 0) return undefined;
  return { readOnlyHint: found.every((hints) => isReadOnly(hints)), destructiveHint: found.some((hints) => isDestructive(hints)) };
}

export function recordedHints(seen: SeenHints | undefined, serverId: string, tools: ToolInfo[], chosen: Record<string, ToolPermission> = {}): Record<string, ToolHints> {
  const kept: Record<string, ToolHints> = {};
  for (const tool of tools.slice(0, MAX_TOOLS_PER_SERVER)) {
    if (!tool.name || tool.name.length > MAX_TOOL_NAME) continue;
    const decided = isPermission(chosen[tool.name]) ? undefined : seenHintsFor(seen, serverId, tool.name);
    kept[tool.name] = decided ?? hintsOnly(tool.annotations);
  }
  return kept;
}

function hintsOnly(hints: ToolHints | undefined): ToolHints {
  const kept: ToolHints = {};
  if (typeof hints?.readOnlyHint === "boolean") kept.readOnlyHint = hints.readOnlyHint;
  if (typeof hints?.destructiveHint === "boolean") kept.destructiveHint = hints.destructiveHint;
  return kept;
}

export function stricter(a: ToolPermission, b: ToolPermission): ToolPermission {
  return RANK[a] >= RANK[b] ? a : b;
}

export function ceilingFor(server: ConnectorCeiling, tool: string, hints?: ToolHints): ToolPermission {
  const key = toolSkeleton(tool);
  const listed = (names: string[] | null | undefined) => (names ?? []).some((name) => toolSkeleton(name) === key);
  if (listed(server.neverTools)) return "never";
  if (server.askAll || listed(server.askTools) || !plainToolName(tool) || (server.askWrites && !isReadOnly(hints))) return "ask";
  return "allow";
}

export function allowedChoices(ceiling: ToolPermission) {
  return PERMISSIONS.filter((permission) => RANK[permission] >= RANK[ceiling]);
}

export function ownerChoice(policy: ToolPolicy | undefined, legacyAsk: string[] | undefined, serverId: string, tool: string): ToolPermission | undefined {
  const chosen = lookup(policy?.[serverId], tool).filter(isPermission);
  if (chosen.length) return chosen.reduce(stricter);
  const key = toolKey(tool);
  if ((legacyAsk ?? []).some((entry) => entry.startsWith(`${serverId}:`) && toolKey(entry.slice(serverId.length + 1)) === key)) return "ask";
  return undefined;
}

export function effectivePermission(input: {
  serverId: string;
  server: ConnectorCeiling;
  tool: ToolInfo;
  policy?: ToolPolicy;
  legacyAsk?: string[];
  seen?: SeenHints;
}): { permission: ToolPermission; source: "admin" | "owner" | "default"; changed?: "safer" | "riskier" | "new" } {
  const seen = seenHintsFor(input.seen, input.serverId, input.tool.name);
  const ceiling = ceilingFor(input.server, input.tool.name, trustedHints(seen, input.tool.annotations));
  const picked = ownerChoice(input.policy, input.legacyAsk, input.serverId, input.tool.name);
  const riskier = picked === "allow" && hintsTightened(seen, input.tool.annotations);
  const chosen = riskier ? undefined : picked;
  const unrecorded = !chosen && !seen && hintsRecordedFor(input.seen, input.serverId);
  const wanted = chosen ?? (riskier || unrecorded ? "ask" : defaultPermission(trustedHints(seen, input.tool.annotations)));
  const permission = stricter(wanted, ceiling);
  const source = permission !== wanted ? "admin" : chosen ? "owner" : "default";
  const changed = riskier || (!chosen && hintsTightened(seen, input.tool.annotations)) ? "riskier" : unrecorded ? "new" : !chosen && hintsLoosened(seen, input.tool.annotations) ? "safer" : undefined;
  return { permission, source, ...(changed ? { changed } : {}) };
}

export function withoutStaleAllows(policy: Record<string, ToolPermission>, serverId: string, tools: ToolInfo[], seen: SeenHints | undefined) {
  const next = { ...policy };
  for (const tool of tools) if (next[tool.name] === "allow" && hintsTightened(seenHintsFor(seen, serverId, tool.name), tool.annotations)) delete next[tool.name];
  return next;
}

export function mergeRecordedHints(input: { stored?: SeenHints; submitted: SeenHints; before?: ToolPolicy; after: ToolPolicy }): SeenHints {
  const merged: SeenHints = Object.fromEntries(Object.entries(input.stored ?? {}).map(([serverId, tools]) => [serverId, { ...tools }]));
  for (const [serverId, tools] of Object.entries(input.submitted)) {
    const first = !hintsRecordedFor(input.stored, serverId);
    const kept = { ...(merged[serverId] ?? {}) };
    for (const [tool, hints] of Object.entries(tools)) {
      const now = input.after[serverId]?.[tool];
      const chose = isPermission(now) && (now !== input.before?.[serverId]?.[tool] || hintsTightened(kept[tool], hints) || !kept[tool]);
      if (first || chose) kept[tool] = hintsOnly(hints);
    }
    if (Object.keys(kept).length) merged[serverId] = kept;
  }
  return merged;
}

export function canAlwaysAllow(server: ConnectorCeiling, tool: string, hints?: ToolHints) {
  return ceilingFor(server, tool, hints) === "allow";
}

export function withChoice(policy: Record<string, ToolPermission>, tool: ToolInfo, permission: ToolPermission) {
  return { ...policy, [tool.name]: permission };
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

export function cleanSeenHints(input: unknown, serverIds: string[]): SeenHints {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const allowed = new Set(serverIds);
  const clean: SeenHints = {};
  for (const [serverId, tools] of Object.entries(input as Record<string, unknown>)) {
    if (Object.keys(clean).length >= MAX_SERVERS) break;
    if (!allowed.has(serverId) || !tools || typeof tools !== "object" || Array.isArray(tools)) continue;
    const entries = Object.entries(tools as Record<string, unknown>)
      .filter(([name, hints]) => name.length > 0 && name.length <= MAX_TOOL_NAME && Boolean(hints) && typeof hints === "object" && !Array.isArray(hints))
      .slice(0, MAX_TOOLS_PER_SERVER)
      .map(([name, hints]) => [name, hintsOnly(hints as ToolHints)] as const);
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
