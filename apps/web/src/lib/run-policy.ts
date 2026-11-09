import { looksIrreversible, type ApprovalFallback, type ApprovalMode, type Recipe } from "@understudy/protocol";

export const UNTRUSTED_RUN_TRIGGERS: readonly string[] = ["webhook", "email", "handoff", "watch"];

export function untrustedTrigger(trigger: string) {
  return UNTRUSTED_RUN_TRIGGERS.includes(trigger);
}

export function quotedInputTrigger(trigger: string) {
  return untrustedTrigger(trigger) || trigger === "followup";
}

export const UNANSWERED_AFTER_MS = 30 * 60 * 1000;

export const OWNER_STARTED_TRIGGERS: readonly string[] = ["schedule", "manual"];

export function unansweredOutcome(input: { fallback: ApprovalFallback; askedBy: string | null; runTrigger: string | null }): "deny" | "allow" | null {
  if (input.fallback === "deny") return "deny";
  if (input.fallback !== "allow" || input.askedBy || !input.runTrigger) return null;
  return OWNER_STARTED_TRIGGERS.includes(input.runTrigger) ? "allow" : null;
}

export function approvalsRequiredFor(input: { recipe: Recipe; askAlways: boolean; runsDone: number; trigger: string; mode?: ApprovalMode }) {
  if (input.askAlways || input.mode === "always" || input.trigger === "test" || quotedInputTrigger(input.trigger)) return true;
  if (input.mode !== "off" && input.runsDone < input.recipe.askFirstRuns) return true;
  return input.recipe.steps.some((step) => step.mode === "ask" && looksIrreversible(`${step.text} ${step.detail ?? ""}`));
}
