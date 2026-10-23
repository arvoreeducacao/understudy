"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq, ne } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { env, isGoogleOnlyEmail } from "@/lib/env";
import { messages } from "@/lib/messages";
import { getAuth } from "@/lib/auth";
import { currentUser, requireAdmin } from "@/lib/session";
import { issueResetLink, resetLinkOwner } from "@/lib/reset-link";
import { bootstrapAllowed, createUserWithPassword, hasAnyUser } from "@/lib/users";
import { getHub } from "@/server/hub-access";

export async function setUserStatus(userId: string, status: "approved" | "rejected" | "pending") {
  await requireAdmin();
  await getDb().update(schema.user).set({ status, updatedAt: new Date() }).where(eq(schema.user.id, userId));
  if (status !== "approved") {
    await getDb().delete(schema.session).where(eq(schema.session.userId, userId));
    const hub = getHub();
    const owned = await getDb().select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.ownerId, userId));
    hub?.closeViewers((agentId, viewer) => viewer.userId === userId || owned.some((a) => a.id === agentId));
    for (const agent of owned) {
      hub?.stopComputer(agent.id);
      hub?.closeComputer(agent.id);
    }
  }
  revalidatePath("/admin");
}

export async function createUserAccount(_: { ok?: boolean; message?: string } | null, form: FormData) {
  await requireAdmin();
  const email = String(form.get("email") ?? "").trim();
  const name = String(form.get("name") ?? "").trim();
  const password = String(form.get("password") ?? "");
  try {
    await createUserWithPassword({ email, name, password });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "";
    console.error(JSON.stringify({ event: "create_user_failed", reason }));
    const text =
      reason === "domain_not_allowed"
        ? messages.auth.domainNotAllowed(env.allowedEmailDomains)
        : reason === "google_only"
          ? messages.admin.createGoogleOnly(env.googleOnlyDomains)
          : messages.admin.createFailed;
    return { ok: false, message: text };
  }
  revalidatePath("/admin");
  return { ok: true, message: messages.admin.created(email) };
}

export async function changeOwnPassword(_: { error?: string; done?: boolean } | null, form: FormData) {
  const user = await currentUser();
  if (!user) redirect("/sign-in");
  const currentPassword = String(form.get("currentPassword") ?? "");
  const newPassword = String(form.get("newPassword") ?? "");
  if (newPassword.length < 8 || newPassword === currentPassword) return { error: messages.auth.changeFailed };
  const requestHeaders = await headers();
  try {
    await getAuth().api.changePassword({
      body: { currentPassword, newPassword, revokeOtherSessions: false },
      headers: requestHeaders,
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "change_password_failed", userId: user.id, error: String(error) }));
    return { error: messages.auth.changeFailed };
  }
  const current = await getAuth().api.getSession({ headers: requestHeaders });
  const db = getDb();
  await db
    .delete(schema.session)
    .where(current ? and(eq(schema.session.userId, user.id), ne(schema.session.id, current.session.id)) : eq(schema.session.userId, user.id));
  await db
    .update(schema.user)
    .set({ mustChangePassword: false, updatedAt: new Date() })
    .where(eq(schema.user.id, user.id));
  return { done: true };
}

export async function createFirstAdmin(_: { error?: string; email?: string; password?: string } | null, form: FormData) {
  if (!bootstrapAllowed() || (await hasAnyUser())) return { error: messages.setupFirst.taken };
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const name = String(form.get("name") ?? "").trim();
  const password = String(form.get("password") ?? "");
  try {
    await createUserWithPassword({ email, name, password, mustChangePassword: false, source: "setup" });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "";
    console.error(JSON.stringify({ event: "create_user_failed", reason }));
    return {
      error:
        reason === "domain_not_allowed"
          ? messages.auth.domainNotAllowed(env.allowedEmailDomains)
          : messages.auth.signUpFailed,
    };
  }
  return { email, password };
}

export async function createResetLink(userId: string) {
  const admin = await requireAdmin();
  const [target] = await getDb().select().from(schema.user).where(eq(schema.user.id, userId));
  if (!target || target.id === admin.id || target.status !== "approved" || isGoogleOnlyEmail(target.email)) return { error: messages.admin.resetLinkFailed };
  const url = await issueResetLink(target.id);
  console.log(JSON.stringify({ event: "reset_link_issued", userId: target.id, by: admin.id }));
  return { url };
}

export async function resetTwoFactor(userId: string) {
  const admin = await requireAdmin();
  if (userId === admin.id) return;
  const db = getDb();
  await db.delete(schema.twoFactor).where(eq(schema.twoFactor.userId, userId));
  await db.update(schema.user).set({ twoFactorEnabled: false, updatedAt: new Date() }).where(eq(schema.user.id, userId));
  await db.delete(schema.session).where(eq(schema.session.userId, userId));
  console.log(JSON.stringify({ event: "two_factor_reset", userId, by: admin.id }));
  revalidatePath("/admin");
}

export async function resetPasswordWithLink(_: { error?: string; done?: boolean } | null, form: FormData) {
  const token = String(form.get("token") ?? "");
  const newPassword = String(form.get("newPassword") ?? "");
  if (newPassword.length < 8) return { error: messages.resetPassword.tooShort };
  const userId = await resetLinkOwner(token);
  if (!userId) return { error: messages.resetPassword.expired };
  try {
    await getAuth().api.resetPassword({ body: { token, newPassword } });
  } catch (error) {
    console.error(JSON.stringify({ event: "reset_password_failed", error: String(error) }));
    return { error: messages.resetPassword.expired };
  }
  await getDb().update(schema.user).set({ mustChangePassword: false, updatedAt: new Date() }).where(eq(schema.user.id, userId));
  return { done: true };
}
