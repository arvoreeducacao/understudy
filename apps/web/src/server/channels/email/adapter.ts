import { randomBytes } from "node:crypto";
import { formatBytes } from "@understudy/protocol";
import { messages as copy } from "@/lib/messages";
import { readWholeFile } from "../../artifacts/service";
import type { ChannelAdapter } from "../adapter";
import { recordSent } from "../store";
import { channelAddress, emailChannelDomain, emailChannelReady, replySubject } from "./address";
import { composeEmail, emailSender, type EmailSender, type OutgoingFile } from "./outbound";

export const ATTACHMENT_TOTAL_BYTES = 20 * 1024 * 1024;

export function newMessageId(domain: string) {
  return `<${Date.now().toString(36)}.${randomBytes(12).toString("hex")}@${domain}>`;
}

export function emailAdapter(sender: () => EmailSender | null = () => emailSender()): ChannelAdapter {
  return {
    kind: "email",
    ready: () => emailChannelReady(),
    async send(hub, { agentId, agentName, channel, thread, reply }) {
      const send = sender();
      if (!send) throw new Error("outbound email is not configured");
      const domain = emailChannelDomain();
      const files: OutgoingFile[] = [];
      const left: string[] = [];
      let total = 0;
      for (const file of reply.files) {
        if (total + file.size > ATTACHMENT_TOTAL_BYTES) {
          left.push(`${file.name} (${formatBytes(file.size)})`);
          continue;
        }
        const read = await readWholeFile(hub, agentId, file.path, ATTACHMENT_TOTAL_BYTES - total);
        if (!read.data) {
          left.push(file.name);
          continue;
        }
        total += read.data.length;
        files.push({ filename: file.name, contentType: file.mime, content: read.data });
      }
      const notes = left.length ? `\n\n${copy.channels.notAttached(left.join(", "))}` : "";
      const text = `${reply.text.trim()}${notes}`.trim() || (files.length ? files.map((file) => file.filename).join(", ") : "");
      if (!text && !files.length) return;
      const messageId = newMessageId(domain);
      const references = [...thread.references.split(/\s+/).filter(Boolean), ...(thread.lastMessageId ? [thread.lastMessageId] : [])];
      const unique = [...new Set(references)].slice(-20);
      const address = channelAddress(channel.address);
      const raw = await composeEmail({
        from: { name: agentName, address },
        to: thread.peer,
        subject: replySubject(thread.subject) || agentName,
        text,
        messageId,
        inReplyTo: thread.lastMessageId,
        references: unique,
        attachments: files,
      });
      await send(raw, { from: address, to: [thread.peer] });
      await recordSent(thread.id, messageId, [...unique, messageId]);
    },
  };
}
