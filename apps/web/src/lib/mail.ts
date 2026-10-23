import nodemailer, { type Transporter } from "nodemailer";
import { env } from "./env";

const store = globalThis as unknown as { __understudyMail?: { url: string; transport: Transporter } };

export function mailEnabled() {
  return Boolean(env.smtpUrl);
}

// "json" builds the message without sending it, for development and tests.
function transport(url: string) {
  if (store.__understudyMail?.url !== url) {
    store.__understudyMail = { url, transport: url === "json" ? nodemailer.createTransport({ jsonTransport: true }) : nodemailer.createTransport(url) };
  }
  return store.__understudyMail.transport;
}

export async function sendMail(message: { to: string; subject: string; text: string }) {
  const url = env.smtpUrl;
  if (!url) throw new Error("mail_not_configured");
  await transport(url).sendMail({ from: env.mailFrom, ...message });
}
