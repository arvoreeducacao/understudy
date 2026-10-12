import type { ChannelKind, PendingFile } from "@/lib/db/schema";
import type { Hub } from "../hub";
import type { ApprovalView } from "../hub-types";
import type { AgentChannel, ChannelOwner, ChannelThread } from "./store";

export type ChannelReply = { text: string; files: PendingFile[] };

export type ApprovalNotice = { agentId: string; agentName: string; channel: AgentChannel; routeThread: ChannelThread; owner: ChannelOwner; approval: ApprovalView };

export type LiveConversation = {
  activeSince(agentId: string): Promise<Date | null>;
  say(agentId: string, text: string, streamId?: string): Promise<boolean>;
  delta?(agentId: string, streamId: string, text: string): Promise<void>;
  activity?(agentId: string, text: string): Promise<void>;
  approval?(agentId: string, approval: ApprovalView): Promise<boolean>;
  panelSaid?(agentId: string, author: string, text: string): Promise<void>;
  runStarted?(agentId: string, runId: string, title: string, steps: string[]): Promise<void>;
  runFinished?(agentId: string, runId: string, title: string, steps: string[], ok: boolean, summary: string): Promise<void>;
};

export type ChannelAdapter = {
  kind: ChannelKind;
  ready(): boolean;
  send?(hub: Hub, input: { agentId: string; agentName: string; channel: AgentChannel; thread: ChannelThread; reply: ChannelReply }): Promise<void>;
  sendApproval?(hub: Hub, notice: ApprovalNotice): Promise<boolean>;
  live?: LiveConversation;
};
