import { z } from "zod";
import { normalizeSite } from "./rules.ts";

export const APPROVAL_MODES = ["always", "on-miss", "auto", "off"] as const;
export const APPROVAL_FALLBACKS = ["wait", "deny", "allow"] as const;
export const APPROVAL_ALLOW_KINDS = ["host", "tool"] as const;
export const APPROVAL_ALLOW_LIMIT = 200;

export const ApprovalModeSchema = z.enum(APPROVAL_MODES);
export const ApprovalFallbackSchema = z.enum(APPROVAL_FALLBACKS);
export const ApprovalAllowSchema = z.object({ kind: z.enum(APPROVAL_ALLOW_KINDS), value: z.string().min(1).max(253) });
export const ComputerApprovalPolicySchema = z.object({
  mode: ApprovalModeSchema,
  hosts: z.array(z.string().min(1).max(253)).max(APPROVAL_ALLOW_LIMIT),
  ownerId: z.string().min(1).max(200).optional(),
});

export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;
export type ApprovalFallback = z.infer<typeof ApprovalFallbackSchema>;
export type ApprovalAllow = z.infer<typeof ApprovalAllowSchema>;
export type ApprovalPolicy = { mode: ApprovalMode; allow: ApprovalAllow[]; fallback: ApprovalFallback };
export type ComputerApprovalPolicy = z.infer<typeof ComputerApprovalPolicySchema>;
export type EffectiveApprovalMode = ApprovalMode;

export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = { mode: "on-miss", allow: [], fallback: "wait" };

const HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const TOOL_NAME = /^[a-z0-9][a-z0-9_.:-]{0,199}$/;

export function allowedHost(value: string): string | null {
  const site = normalizeSite(value);
  return HOST_NAME.test(site) ? site : null;
}

export function allowedTool(value: string): string | null {
  const name = value.normalize("NFKC").trim().toLowerCase().replace(/^mcp__gatekeeper__/, "");
  return TOOL_NAME.test(name) ? name : null;
}

export function cleanAllowEntry(input: unknown): ApprovalAllow | null {
  if (!input || typeof input !== "object") return null;
  const { kind, value } = input as { kind?: unknown; value?: unknown };
  if (typeof value !== "string") return null;
  if (kind === "host") {
    const host = allowedHost(value);
    return host ? { kind, value: host } : null;
  }
  if (kind === "tool") {
    const tool = allowedTool(value);
    return tool ? { kind, value: tool } : null;
  }
  return null;
}

function sameEntry(a: ApprovalAllow, b: ApprovalAllow) {
  return a.kind === b.kind && a.value === b.value;
}

export function cleanApprovalPolicy(input: unknown): ApprovalPolicy {
  const value = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const mode = APPROVAL_MODES.find((candidate) => candidate === value.mode) ?? DEFAULT_APPROVAL_POLICY.mode;
  const fallback = APPROVAL_FALLBACKS.find((candidate) => candidate === value.fallback) ?? DEFAULT_APPROVAL_POLICY.fallback;
  const allow: ApprovalAllow[] = [];
  for (const entry of Array.isArray(value.allow) ? value.allow : []) {
    const clean = cleanAllowEntry(entry);
    if (clean && !allow.some((kept) => sameEntry(kept, clean))) allow.push(clean);
    if (allow.length >= APPROVAL_ALLOW_LIMIT) break;
  }
  return { mode, allow, fallback };
}

export function withAllowed(policy: ApprovalPolicy, entry: ApprovalAllow): ApprovalPolicy {
  const clean = cleanAllowEntry(entry);
  if (!clean || policy.allow.some((kept) => sameEntry(kept, clean))) return policy;
  return { ...policy, allow: [...policy.allow, clean].slice(-APPROVAL_ALLOW_LIMIT) };
}

export function withoutAllowed(policy: ApprovalPolicy, entry: ApprovalAllow): ApprovalPolicy {
  return { ...policy, allow: policy.allow.filter((kept) => !sameEntry(kept, entry)) };
}

export function listedSite(host: string, hosts: readonly string[]): string | null {
  const site = allowedHost(host);
  if (!site) return null;
  return hosts.find((base) => site === base || site.endsWith(`.${base}`)) ?? null;
}

export function siteListed(host: string, hosts: readonly string[]): boolean {
  return listedSite(host, hosts) !== null;
}

export function toolListed(tool: string, allow: readonly ApprovalAllow[]): boolean {
  const name = allowedTool(tool);
  return Boolean(name) && allow.some((entry) => entry.kind === "tool" && entry.value === name);
}

export function listedHosts(policy: Pick<ApprovalPolicy, "allow">): string[] {
  return policy.allow.filter((entry) => entry.kind === "host").map((entry) => entry.value);
}

export function computerApprovalPolicy(policy: ApprovalPolicy, ownerId?: string): ComputerApprovalPolicy {
  return { mode: policy.mode, hosts: listedHosts(policy), ...(ownerId ? { ownerId } : {}) };
}

export function effectiveApprovalMode(mode: ApprovalMode, context: { untrusted?: boolean } = {}): EffectiveApprovalMode {
  if (mode === "always") return "always";
  if (context.untrusted) return "on-miss";
  return mode;
}

export function listCoversActions(mode: EffectiveApprovalMode): boolean {
  return mode === "on-miss" || mode === "auto";
}
