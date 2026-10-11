import type { ChannelKind, PendingFile } from "@/lib/db/schema";
import type { Hub } from "../hub";
import type { AgentChannel, ChannelThread } from "./store";

export type ChannelReply = { text: string; files: PendingFile[] };

export type ChannelAdapter = {
  kind: ChannelKind;
  ready(): boolean;
  send(hub: Hub, input: { agentId: string; agentName: string; channel: AgentChannel; thread: ChannelThread; reply: ChannelReply }): Promise<void>;
};
