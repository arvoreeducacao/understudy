import { uploadLimitFrom } from "@understudy/protocol";
import { AGENT_TALK_CEILING_ENV, parseTalkCeiling } from "./agent-talk";
import { trustedForAdminList } from "./approval-policy";

function list(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export const env = {
  get productName() {
    return process.env.UNDERSTUDY_PRODUCT_NAME?.trim() || "Understudy";
  },
  get publicUrl() {
    return (process.env.UNDERSTUDY_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, "");
  },
  get allowedEmailDomains() {
    return list(process.env.UNDERSTUDY_ALLOWED_EMAIL_DOMAIN).map((domain) => domain.replace(/^@/, ""));
  },
  get adminEmails() {
    return list(process.env.UNDERSTUDY_ADMIN_EMAILS);
  },
  get slackBotToken() {
    return process.env.SLACK_BOT_TOKEN?.trim() || undefined;
  },
  get hostToken() {
    return process.env.UNDERSTUDY_HOST_TOKEN?.trim() || undefined;
  },
  get computerServerUrl() {
    return (process.env.UNDERSTUDY_COMPUTER_SERVER_URL?.trim() || this.publicUrl).replace(/\/$/, "");
  },
  get computerImage() {
    return process.env.UNDERSTUDY_COMPUTER_IMAGE?.trim() ?? "";
  },
  get hostIds() {
    return list(process.env.UNDERSTUDY_HOST_IDS);
  },
  get agentTalkCeiling() {
    return parseTalkCeiling(process.env[AGENT_TALK_CEILING_ENV]);
  },
  get uploadMaxBytes() {
    return uploadLimitFrom(process.env.UNDERSTUDY_UPLOAD_MAX_BYTES);
  },
  get googleEnabled() {
    return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  },
};

export function isAdminEmail(email: string) {
  return env.adminEmails.includes(email.trim().toLowerCase());
}

export function isAdmin(email: string, flaggedAdmin: boolean, source?: string | null) {
  return env.adminEmails.length > 0 ? isAdminEmail(email) && trustedForAdminList(source) : flaggedAdmin;
}

export function isAllowedEmail(email: string) {
  const domains = env.allowedEmailDomains;
  if (domains.length === 0) return true;
  const address = email.trim().toLowerCase();
  return domains.some((domain) => address.endsWith(`@${domain}`));
}
