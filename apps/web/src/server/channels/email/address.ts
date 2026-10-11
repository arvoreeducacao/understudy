import { inboundConfig } from "../../inbound-email/config";
import { outboundConfig } from "./outbound";

export function emailChannelDomain(env: NodeJS.ProcessEnv = process.env) {
  return inboundConfig(env).domain;
}

export function emailChannelReady(env: NodeJS.ProcessEnv = process.env) {
  return Boolean(emailChannelDomain(env)) && outboundConfig(env).mode !== "off";
}

export function channelAddress(localPart: string, env: NodeJS.ProcessEnv = process.env) {
  return `${localPart}@${emailChannelDomain(env)}`;
}

export function replySubject(subject: string) {
  const clean = subject.replace(/[\r\n]+/g, " ").trim();
  if (!clean) return "";
  return /^re:/i.test(clean) ? clean : `Re: ${clean}`;
}

const QUOTE_HEADERS = [
  /^On .{4,200} wrote:\s*$/,
  /^Em .{4,200} escreveu:\s*$/,
  /^El .{4,200} escribió:\s*$/,
  /^Le .{4,200} a écrit\s*:\s*$/,
  /^Am .{4,200} schrieb .{0,100}:\s*$/,
  /^-{2,}\s*(Original Message|Forwarded message)\s*-{2,}\s*$/i,
];

function quoteStarts(lines: string[], index: number) {
  const line = lines[index].trim();
  if (QUOTE_HEADERS.some((pattern) => pattern.test(line))) return true;
  return /^(From|De):\s.+/.test(line) && /^(Sent|Date|To|Enviado|Data|Para):\s/.test(lines[index + 1]?.trim() ?? "");
}

export function stripQuoted(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let end = lines.findIndex((_, index) => index > 0 && quoteStarts(lines, index));
  if (end < 0) end = lines.length;
  while (end > 0 && (lines[end - 1].trim().startsWith(">") || lines[end - 1].trim() === "")) end -= 1;
  const kept = lines.slice(0, end).join("\n").trim();
  return kept || text.trim();
}
