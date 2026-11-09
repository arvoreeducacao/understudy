import { eq } from "drizzle-orm";
import { cleanApprovalPolicy, computerApprovalPolicy, withAllowed, type ApprovalAllow, type ApprovalPolicy, type ServerToComputer } from "@understudy/protocol";
import { getDb, schema } from "@/lib/db";
import { quotedInputTrigger } from "@/lib/run-policy";

type PolicyHolder = { id: string; ownerId: string; approvalPolicy: unknown };

type ComputerLink = { sendToComputer: (agentId: string, message: ServerToComputer) => unknown };

function log(event: string, data: Record<string, unknown>) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
}

export function approvalPolicyMessage(agent: PolicyHolder): ServerToComputer {
  return { type: "set_approval_policy", policy: computerApprovalPolicy(cleanApprovalPolicy(agent.approvalPolicy), agent.ownerId) };
}

export async function updateApprovalPolicy(link: ComputerLink | null, agentId: string, change: (policy: ApprovalPolicy) => ApprovalPolicy, onlyOwner?: string) {
  const saved = await getDb().transaction(async (tx) => {
    const [agent] = await tx.select({ id: schema.agents.id, ownerId: schema.agents.ownerId, approvalPolicy: schema.agents.approvalPolicy }).from(schema.agents).where(eq(schema.agents.id, agentId)).for("update");
    if (!agent || (onlyOwner !== undefined && agent.ownerId !== onlyOwner)) return null;
    const policy = cleanApprovalPolicy(change(cleanApprovalPolicy(agent.approvalPolicy)));
    await tx.update(schema.agents).set({ approvalPolicy: policy, updatedAt: new Date() }).where(eq(schema.agents.id, agentId));
    return { ...agent, approvalPolicy: policy };
  });
  if (!saved) return null;
  link?.sendToComputer(agentId, approvalPolicyMessage(saved));
  log("approval_policy_saved", { agentId, mode: saved.approvalPolicy.mode, allowed: saved.approvalPolicy.allow.length, fallback: saved.approvalPolicy.fallback });
  return saved.approvalPolicy;
}

export async function grantAllowEntry(link: ComputerLink | null, agentId: string, entry: ApprovalAllow, userId: string) {
  const saved = await updateApprovalPolicy(link, agentId, (policy) => withAllowed(policy, entry), userId);
  return Boolean(saved?.allow.some((kept) => kept.kind === entry.kind && kept.value === entry.value));
}

export function untrustedTurnFor(input: { ownerId: string; audience: string | null; flagged: boolean; runTrigger: string | null }) {
  if (input.flagged) return true;
  if (input.audience && input.audience !== input.ownerId) return true;
  return Boolean(input.runTrigger && quotedInputTrigger(input.runTrigger));
}
