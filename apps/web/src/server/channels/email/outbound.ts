import { AwsClient } from "aws4fetch";
import nodemailer from "nodemailer";
import { awsCredentials } from "../../inbound-email/aws";

export type OutboundConfig = { mode: "ses"; region: string } | { mode: "smtp"; url: string } | { mode: "off" };

export function outboundConfig(env: NodeJS.ProcessEnv = process.env): OutboundConfig {
  const raw = (env.UNDERSTUDY_OUTBOUND_EMAIL ?? "").trim();
  if (raw.toLowerCase() === "ses") {
    const region = env.UNDERSTUDY_OUTBOUND_EMAIL_REGION?.trim() || env.AWS_REGION?.trim() || env.UNDERSTUDY_INBOUND_SNS_TOPIC_ARN?.split(":")[3] || "us-east-1";
    return { mode: "ses", region };
  }
  if (/^smtps?:\/\/[^\s]+$/i.test(raw)) return { mode: "smtp", url: raw };
  return { mode: "off" };
}

export type OutgoingFile = { filename: string; contentType: string; content: Buffer };

export type OutgoingEmail = {
  from: { name: string; address: string };
  to: string;
  subject: string;
  text: string;
  messageId: string;
  inReplyTo?: string | null;
  references: string[];
  attachments: OutgoingFile[];
};

export type Envelope = { from: string; to: string[] };

export type EmailSender = (raw: Buffer, envelope: Envelope) => Promise<void>;

export async function composeEmail(mail: OutgoingEmail): Promise<Buffer> {
  const builder = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows" });
  const info = await builder.sendMail({
    from: { name: mail.from.name.replace(/["<>\r\n]/g, "").slice(0, 80), address: mail.from.address },
    to: mail.to,
    subject: mail.subject.replace(/[\r\n]+/g, " ").slice(0, 300),
    text: mail.text,
    messageId: mail.messageId,
    ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo } : {}),
    ...(mail.references.length ? { references: mail.references } : {}),
    headers: { "Auto-Submitted": "auto-replied", "X-Auto-Response-Suppress": "All" },
    attachments: mail.attachments.map((file) => ({ filename: file.filename, contentType: file.contentType, content: file.content })),
  });
  return info.message as Buffer;
}

function sesSender(region: string): EmailSender {
  return async (raw) => {
    const credentials = await awsCredentials();
    const client = new AwsClient({ ...credentials, service: "ses", region });
    const response = await client.fetch(`https://email.${region}.amazonaws.com/v2/email/outbound-emails`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Content: { Raw: { Data: raw.toString("base64") } } }),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`ses ${response.status}: ${(await response.text()).slice(0, 300)}`);
  };
}

function smtpSender(url: string): EmailSender {
  const transport = nodemailer.createTransport(url);
  return async (raw, envelope) => {
    await transport.sendMail({ envelope, raw });
  };
}

let cached: { key: string; sender: EmailSender } | null = null;

export function emailSender(config: OutboundConfig = outboundConfig()): EmailSender | null {
  if (config.mode === "off") return null;
  const key = config.mode === "ses" ? `ses:${config.region}` : `smtp:${config.url}`;
  if (cached?.key === key) return cached.sender;
  cached = { key, sender: config.mode === "ses" ? sesSender(config.region) : smtpSender(config.url) };
  return cached.sender;
}
