import { isOffRecipe } from "@/lib/approval-fields";
import { messages as copy } from "@/lib/messages";
import type { ApprovalView } from "../hub-types";

const FIELD_CHARS = 500;
const FIELDS_CHARS = 3000;

export function approvalText(input: { agentName: string; approval: Pick<ApprovalView, "summary" | "fields"> }) {
  const fields = input.approval.fields
    .map((field) => `${field.label}: ${field.value.trim() ? field.value.trim().slice(0, FIELD_CHARS) : copy.approvals.emptyValue}`)
    .join("\n")
    .slice(0, FIELDS_CHARS);
  return [...(isOffRecipe(input.approval.fields) ? [copy.approvals.offRecipe, ""] : []), copy.channels.approvalAsk(input.agentName), "", input.approval.summary, ...(fields ? ["", fields] : [])].join("\n");
}
