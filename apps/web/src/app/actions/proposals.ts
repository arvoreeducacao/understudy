"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { getHub } from "@/server/hub-access";

export type ProposalChoice = "save" | "edit" | "dismiss";

export async function answerProposal(proposalId: string, choice: ProposalChoice) {
  const user = await requireUser();
  const [row] = await getDb()
    .select({ agentId: schema.taskProposals.agentId })
    .from(schema.taskProposals)
    .innerJoin(schema.agents, eq(schema.agents.id, schema.taskProposals.agentId))
    .where(and(eq(schema.taskProposals.id, String(proposalId)), eq(schema.agents.ownerId, user.id)));
  const hub = getHub();
  if (!row || !hub) return { ok: false as const };
  const answered = await hub.proposals.answer(String(proposalId), choice !== "dismiss", user.id, { keepPaused: choice === "edit" });
  if (!answered) return { ok: false as const };
  revalidatePath(`/agents/${row.agentId}`, "layout");
  return {
    ok: true as const,
    proposal: answered,
    redirectTo: choice === "edit" && answered.recipeId ? `/agents/${row.agentId}/recipes/${answered.recipeId}` : undefined,
  };
}
