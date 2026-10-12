import type { ChannelKind, PendingFile } from "@/lib/db/schema";
import type { Hub } from "../hub";
import type { ApprovalView } from "../hub-types";
import type { AgentChannel, ChannelOwner, ChannelThread } from "./store";

export type ChannelReply = { text: string; files: PendingFile[] };

export type ApprovalNotice = { agentId: string; agentName: string; channel: AgentChannel; routeThread: ChannelThread; owner: ChannelOwner; approval: ApprovalView };

export type ChannelAdapter = {
  kind: ChannelKind;
  ready(): boolean;
  send(hub: Hub, input: { agentId: string; agentName: string; channel: AgentChannel; thread: ChannelThread; reply: ChannelReply }): Promise<void>;
  sendApproval?(hub: Hub, notice: ApprovalNotice): Promise<boolean>;
};
