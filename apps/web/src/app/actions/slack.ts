"use server";

import { revalidatePath } from "next/cache";
import { deleteSetting, writeSetting } from "@/lib/app-settings";
import { messages } from "@/lib/messages";
import { requireAdmin } from "@/lib/session";
import { forgetSlackConfig, SLACK_SECRET_FIELDS, slackCall } from "@/server/slack";

export async function saveSlackConfig(_: { ok?: boolean; message?: string } | null, form: FormData) {
  const admin = await requireAdmin();
  const botToken = String(form.get("botToken") ?? "").trim();
  const signingSecret = String(form.get("signingSecret") ?? "").trim();
  if (!/^xoxb-[A-Za-z0-9-]{10,}$/.test(botToken) || !/^[a-f0-9]{20,64}$/i.test(signingSecret)) return { ok: false, message: messages.slackAdmin.invalid };
  const check = (await slackCall("auth.test", {}, botToken)) as { ok: boolean; error?: string; team?: string; user_id?: string };
  if (!check.ok) {
    console.error(JSON.stringify({ event: "slack_config_rejected", error: check.error, by: admin.id }));
    return { ok: false, message: messages.slackAdmin.rejected(check.error ?? "") };
  }
  await writeSetting("slack", { botToken, signingSecret, teamName: check.team ?? "", botUserId: check.user_id ?? "" }, SLACK_SECRET_FIELDS);
  forgetSlackConfig();
  console.log(JSON.stringify({ event: "slack_config_saved", team: check.team, by: admin.id }));
  revalidatePath("/admin/slack");
  return { ok: true, message: messages.slackAdmin.saved(check.team ?? "") };
}

export async function removeSlackConfig() {
  const admin = await requireAdmin();
  await deleteSetting("slack");
  forgetSlackConfig();
  console.log(JSON.stringify({ event: "slack_config_removed", by: admin.id }));
  revalidatePath("/admin/slack");
}
