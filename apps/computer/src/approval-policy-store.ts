import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { allowedHost, ComputerApprovalPolicySchema, DEFAULT_APPROVAL_POLICY, type ComputerApprovalPolicy } from "@understudy/protocol";

export const DEFAULT_COMPUTER_POLICY: ComputerApprovalPolicy = { mode: DEFAULT_APPROVAL_POLICY.mode, hosts: [] };

const MAX_APPROVED_SITES = 200;

export function approvalPolicyFile(home: string): string {
  return join(home, ".understudy", "approval-policy.json");
}

export function approvedSitesFile(home: string): string {
  return join(home, ".understudy", "approved-sites.json");
}

function writePrivate(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function readApprovalPolicy(file: string): ComputerApprovalPolicy {
  const parsed = ComputerApprovalPolicySchema.safeParse(readJson(file));
  return parsed.success ? parsed.data : DEFAULT_COMPUTER_POLICY;
}

export function writeApprovalPolicy(file: string, policy: ComputerApprovalPolicy) {
  writePrivate(file, policy);
}

export function sitesApprovedIn(file: string, conversation: string | undefined): string[] {
  if (!conversation) return [];
  const stored = readJson(file) as { conversation?: unknown; sites?: unknown } | null;
  if (!stored || stored.conversation !== conversation || !Array.isArray(stored.sites)) return [];
  return stored.sites.filter((site): site is string => typeof site === "string" && allowedHost(site) === site);
}

export function rememberApprovedSite(file: string, conversation: string | undefined, host: string) {
  const site = allowedHost(host);
  if (!conversation || !site) return;
  const sites = sitesApprovedIn(file, conversation);
  if (sites.includes(site)) return;
  writePrivate(file, { conversation, sites: [...sites, site].slice(-MAX_APPROVED_SITES) });
}
