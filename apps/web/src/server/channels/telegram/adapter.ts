import { env } from "@/lib/env";
import { messages as copy } from "@/lib/messages";
import { open } from "@/lib/secret-box";
import type { ChannelAdapter } from "../adapter";
import { channelEnabled } from "../enabled";
import { approvalText } from "../approval-text";
import { readReplyFiles } from "../reply-files";
import { recordSent } from "../store";
import { splitText, telegramCall, type TelegramResult } from "./api";
import { telegramSettings } from "./settings";

export const TELEGRAM_FILE_LIMIT = 45 * 1024 * 1024;
export const TELEGRAM_REPLY_LIMIT = 90 * 1024 * 1024;

function token(channel: { secret: string | null }) {
  const value = channel.secret ? open(channel.secret) : "";
  if (!value) throw new Error("telegram bot is not connected");
  return value;
}

async function must<T>(call: Promise<TelegramResult<T>>): Promise<T> {
  const value = await call;
  if (!value.ok) throw new Error(`telegram: ${value.description ?? "request failed"}`);
  return value.result;
}

export function telegramAdapter(): ChannelAdapter {
  return {
    kind: "telegram",
    ready: () => channelEnabled("telegram"),
    async send(hub, { agentId, channel, thread, reply }) {
      const bot = token(channel);
      const { files, note } = await readReplyFiles(hub, agentId, reply.files, TELEGRAM_REPLY_LIMIT, TELEGRAM_FILE_LIMIT);
      const text = [reply.text.trim(), note].filter(Boolean).join("\n\n");
      let last = "";
      for (const part of splitText(text)) {
        const sent = await must(telegramCall<{ message_id: number }>(bot, "sendMessage", { chat_id: thread.peer, text: part }));
        last = String(sent.message_id ?? last);
      }
      for (const file of files) {
        const form = new FormData();
        form.set("chat_id", thread.peer);
        form.set("document", new Blob([new Uint8Array(file.content)], { type: file.contentType }), file.filename);
        const sent = await must(telegramCall<{ message_id: number }>(bot, "sendDocument", form));
        last = String(sent.message_id ?? last);
      }
      if (last) await recordSent(thread.id, last, []);
    },
    async sendApproval(_hub, notice) {
      const settings = telegramSettings(notice.channel);
      if (!settings.ownerUserId) return false;
      const bot = token(notice.channel);
      const id = notice.approval.id;
      const panel = `${env.publicUrl}/waiting`;
      const keyboard = [
        [
          { text: copy.channels.answerApprove, callback_data: `apr:${id}:y` },
          { text: copy.channels.answerDeny, callback_data: `apr:${id}:n` },
        ],
        ...(notice.approval.alwaysAllow ? [[{ text: copy.toolAccess.approveAlways, callback_data: `apr:${id}:a` }]] : []),
        ...(panel.startsWith("https://") ? [[{ text: copy.channels.answerOpenPanel, url: panel }]] : []),
      ];
      const text = approvalText({ agentName: notice.agentName, approval: notice.approval }).slice(0, 4000);
      await must(telegramCall(bot, "sendMessage", { chat_id: settings.ownerUserId, text, reply_markup: { inline_keyboard: keyboard } }));
      return true;
    },
  };
}
