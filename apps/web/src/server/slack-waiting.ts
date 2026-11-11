import { and, desc, eq } from "drizzle-orm";
import { agentAccess, canAnswer } from "@/lib/access";
import { alwaysAllowOf } from "@/lib/always-allow";
import { getDb, schema } from "@/lib/db";
import { messages as copy } from "@/lib/messages";
import { rememberApprovalMessage } from "./approval-slack";
import { slackApprovalMessage } from "./channels/slack/adapter";
import { agentIdentity, postMessage } from "./slack";
import { postAgentText } from "./slack-threads";

type Waiting = { agent: { id: string; name: string }; userId: string; channel: string; threadTs?: string };

async function latestPendingApproval(agentId: string) {
  const [row] = await getDb()
    .select()
    .from(schema.approvals)
    .where(and(eq(schema.approvals.agentId, agentId), eq(schema.approvals.status, "pending")))
    .orderBy(desc(schema.approvals.createdAt))
    .limit(1);
  return row ?? null;
}

export async function showPendingApproval(waiting: Waiting) {
  const approval = await latestPendingApproval(waiting.agent.id);
  if (!approval) return false;
  const as = agentIdentity(waiting.agent);
  const threadTs = waiting.threadTs;
  if (!canAnswer(await agentAccess(waiting.userId, waiting.agent.id), approval.askedBy, waiting.userId)) {
    await postAgentText({ channel: waiting.channel, threadTs, text: copy.slackApp.waitingOnOwner, as });
    return true;
  }
  const shownHere = approval.slackMessages?.some((ref) => ref.channel === waiting.channel && ref.threadTs === threadTs);
  if (shownHere) return true;
  const card = await slackApprovalMessage(waiting.agent.name, { id: approval.id, summary: approval.summary, fields: approval.fields, alwaysAllow: alwaysAllowOf(approval.grant) });
  const lead = { type: "section", text: { type: "mrkdwn", text: copy.slackApp.waitingOnYou } };
  const posted = await postMessage({ channel: waiting.channel, threadTs, text: `${copy.slackApp.waitingOnYou} ${card.text}`, blocks: [lead, ...card.blocks], as });
  await rememberApprovalMessage(approval.id, { ...posted, channel: posted.channel ?? waiting.channel }, threadTs);
  return true;
}
