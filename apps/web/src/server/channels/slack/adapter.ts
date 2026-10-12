import { eq } from "drizzle-orm";
import { isOffRecipe } from "@/lib/approval-fields";
import { getDb, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { messages as copy } from "@/lib/messages";
import type { ApprovalView } from "../../hub-types";
import { escapeSlack, slackInteractive } from "../../slack";
import { clipPreview, slackPreview } from "../../slack-preview";
import { activeThread, finishRunProgress, mirrorPanelMessage, postApprovalInThread, relayActivity, relayAgentChat, startRunProgress, streamDelta } from "../../slack-threads";
import type { ChannelAdapter } from "../adapter";

export async function slackApprovalMessage(ownerName: string, approval: Pick<ApprovalView, "id" | "summary" | "fields">) {
  const link = `${env.publicUrl}/waiting`;
  const fieldsText = approval.fields.map((f) => `*${escapeSlack(f.label)}:* ${f.value.trim() ? slackPreview(f.value) : `_${copy.approvals.emptyValue}_`}`).join("\n");
  const clipped = clipPreview(fieldsText);
  const fields = clipped.clipped ? `${clipped.text}…\n${copy.slack.fullInPanel}` : clipped.text;
  const text = copy.slack.approvalText(escapeSlack(ownerName), escapeSlack(approval.summary));
  const interactive = await slackInteractive();
  const blocks = [
    ...(isOffRecipe(approval.fields) ? [{ type: "section", text: { type: "mrkdwn", text: `:warning: ${copy.approvals.offRecipe}` } }] : []),
    { type: "section", text: { type: "mrkdwn", text } },
    ...(fields ? [{ type: "section", text: { type: "mrkdwn", text: fields } }] : []),
    {
      type: "actions",
      elements: [
        ...(interactive
          ? [
              { type: "button", action_id: "approve", text: { type: "plain_text", text: copy.approvals.approve }, value: approval.id, style: "primary" },
              { type: "button", action_id: "deny", text: { type: "plain_text", text: copy.approvals.deny }, value: approval.id, style: "danger" },
            ]
          : []),
        { type: "button", action_id: "open", text: { type: "plain_text", text: copy.slack.openPanel }, url: link, ...(interactive ? {} : { style: "primary" }) },
      ],
    },
  ];
  return { text, blocks };
}

async function agentName(agentId: string) {
  const [agent] = await getDb().select({ name: schema.agents.name }).from(schema.agents).where(eq(schema.agents.id, agentId));
  return agent?.name ?? "";
}

export function slackAdapter(): ChannelAdapter {
  return {
    kind: "slack",
    ready: () => true,
    live: {
      async activeSince(agentId) {
        const thread = await activeThread(agentId);
        return thread ? thread.updatedAt : null;
      },
      say: (agentId, text, streamId) => relayAgentChat(agentId, text, streamId),
      delta: (agentId, streamId, text) => streamDelta(agentId, streamId, text),
      activity: (agentId, text) => relayActivity(agentId, text),
      async approval(agentId, approval) {
        const message = await slackApprovalMessage(await agentName(agentId), approval);
        return postApprovalInThread(agentId, message.blocks, message.text);
      },
      panelSaid: (agentId, author, text) => mirrorPanelMessage(agentId, author, text),
      runStarted: (agentId, runId, title, steps) => startRunProgress(agentId, runId, title, steps),
      runFinished: (agentId, runId, title, steps, ok, summary) => finishRunProgress(agentId, runId, title, steps, ok, summary),
    },
  };
}
