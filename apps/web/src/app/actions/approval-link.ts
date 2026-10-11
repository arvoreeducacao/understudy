"use server";

import { redirect } from "next/navigation";
import { answerByLink } from "@/server/channels/approval-answer";
import { getHub } from "@/server/hub-access";

export async function answerFromEmail(form: FormData) {
  const token = String(form.get("token") ?? "");
  const approved = form.get("decision") === "approve";
  const note = String(form.get("note") ?? "");
  const result = await answerByLink(getHub(), token, approved, note);
  redirect(`/answer/${encodeURIComponent(token)}?done=${result.ok ? (approved ? "approved" : "denied") : "closed"}`);
}
