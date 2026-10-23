import { randomInt } from "node:crypto";
import { messages as copy } from "@/lib/messages";
import type { ChannelAdapter } from "../adapter";
import { approvalText } from "../approval-text";
import { channelEnabled } from "../enabled";
import { readReplyFiles } from "../reply-files";
import { appendChannelList, recordSent } from "../store";
import { MAX_PENDING_APPROVALS } from "./inbound";
import { jidOf } from "./message";

export const WHATSAPP_TEXT_LIMIT = 3500;
export const WHATSAPP_FILE_LIMIT = 30 * 1024 * 1024;
export const WHATSAPP_REPLY_LIMIT = 60 * 1024 * 1024;

const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function approvalCode() {
  return Array.from({ length: 3 }, () => CODE_LETTERS[randomInt(CODE_LETTERS.length)]).join("");
}

export function splitWhatsApp(text: string, limit = WHATSAPP_TEXT_LIMIT) {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const cut = rest.lastIndexOf("\n", limit) > limit / 2 ? rest.lastIndexOf("\n", limit) : limit;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

export function whatsappAdapter(): ChannelAdapter {
  return {
    kind: "whatsapp",
    ready: () => channelEnabled("whatsapp"),
    async send(hub, { agentId, channel, thread, reply }) {
      const jid = jidOf(thread.peer);
      const { files, note } = await readReplyFiles(hub, agentId, reply.files, WHATSAPP_REPLY_LIMIT, WHATSAPP_FILE_LIMIT);
      const text = [reply.text.trim(), note].filter(Boolean).join("\n\n");
      for (const part of splitWhatsApp(text)) await hub.whatsapp.send(channel.id, jid, { text: part });
      for (const file of files) {
        const content = file.contentType.startsWith("image/") && !file.contentType.includes("svg")
          ? { image: file.content, mimetype: file.contentType, caption: file.filename }
          : { document: file.content, mimetype: file.contentType, fileName: file.filename };
        await hub.whatsapp.send(channel.id, jid, content);
      }
      await recordSent(thread.id, String(Date.now()), []);
    },
    async sendApproval(hub, notice) {
      const me = hub.whatsapp.identity(notice.channel.id);
      if (!me) return false;
      const code = approvalCode();
      await appendChannelList(notice.channel.id, "approvals", { code, id: notice.approval.id }, MAX_PENDING_APPROVALS);
      const text = [approvalText({ agentName: notice.agentName, approval: notice.approval }), "", copy.channels.whatsappApprovalHow(code)].join("\n");
      for (const part of splitWhatsApp(text)) await hub.whatsapp.send(notice.channel.id, me.jid, { text: part });
      return true;
    },
  };
}
