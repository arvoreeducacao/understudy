import { env } from "./env";
import { messages } from "./messages";

export const RESET_EMAIL_TTL_SECONDS = 60 * 60;

export function resetEmail(user: { email: string; name: string }, token: string) {
  const t = messages.resetPassword;
  const url = `${env.publicUrl}/reset-password?token=${encodeURIComponent(token)}`;
  return { to: user.email, subject: t.emailSubject(env.productName), text: t.emailBody(user.name || user.email, url) };
}
