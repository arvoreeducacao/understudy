import { looksIrreversible, type Recipe } from "@understudy/protocol";

export const UNTRUSTED_RUN_TRIGGERS: readonly string[] = ["webhook", "email", "handoff", "watch"];

export function untrustedTrigger(trigger: string) {
  return UNTRUSTED_RUN_TRIGGERS.includes(trigger);
}

export function quotedInputTrigger(trigger: string) {
  return untrustedTrigger(trigger) || trigger === "followup";
}

export function approvalsRequiredFor(input: { recipe: Recipe; askAlways: boolean; runsDone: number; trigger: string }) {
  if (input.askAlways || input.trigger === "test" || quotedInputTrigger(input.trigger)) return true;
  if (input.runsDone < input.recipe.askFirstRuns) return true;
  return input.recipe.steps.some((step) => step.mode === "ask" && looksIrreversible(`${step.text} ${step.detail ?? ""}`));
}
