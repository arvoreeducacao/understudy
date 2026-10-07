"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/ids";
import { messages } from "@/lib/messages";
import { requireAdmin } from "@/lib/session";
import { forgetServer, slugify, testConnection } from "@/server/upstream";
import { seal } from "@/lib/secret-box";
import { searchCatalog } from "@/server/connector-catalog";

export type AddServerState = { ok: boolean; message: string } | null;

export async function addMcpServer(_: AddServerState, form: FormData): Promise<AddServerState> {
  const admin = await requireAdmin();
  const name = String(form.get("name") ?? "").trim().slice(0, 60);
  const url = String(form.get("url") ?? "").trim();
  const headerName = String(form.get("headerName") ?? "").trim().slice(0, 100);
  const headerValue = String(form.get("headerValue") ?? "");
  if (!name || !/^https?:\/\//i.test(url)) return { ok: false, message: messages.admin.serverBadInput };
  const db = getDb();
  let slug = slugify(name);
  const taken = await db.select({ slug: schema.mcpServers.slug }).from(schema.mcpServers);
  if (taken.some((t) => t.slug === slug)) slug = `${slug}_${taken.length + 1}`;
  const row = {
    id: newId("mcp"),
    name,
    slug,
    url,
    headerName: headerName || null,
    headerValue: headerName && headerValue ? seal(headerValue) : null,
    createdBy: admin.id,
    createdAt: new Date(),
    askAll: false,
    askTools: [] as string[],
    allowedEmails: null,
  };
  const test = await testConnection(row);
  if (!test.ok) return { ok: false, message: messages.admin.serverProblem[test.problem] };
  await db.insert(schema.mcpServers).values(row);
  revalidatePath("/admin");
  return { ok: true, message: messages.admin.serverAddedWith(name, test.tools.length) };
}

export async function checkMcpServer(id: string) {
  await requireAdmin();
  const [server] = await getDb().select().from(schema.mcpServers).where(eq(schema.mcpServers.id, id));
  if (!server) return { ok: false, message: messages.common.notFound };
  const test = await testConnection(server);
  revalidatePath("/admin");
  return test.ok ? { ok: true, message: messages.admin.serverWorks(test.tools.length) } : { ok: false, message: messages.admin.serverProblem[test.problem] };
}

export async function removeMcpServer(id: string) {
  await requireAdmin();
  await getDb().delete(schema.mcpServers).where(eq(schema.mcpServers.id, id));
  forgetServer(id);
  revalidatePath("/admin");
}

export async function setServerApprovals(id: string, askAll: boolean, askTools: string[]) {
  await requireAdmin();
  await getDb()
    .update(schema.mcpServers)
    .set({ askAll, askTools: askTools.map(String).slice(0, 500) })
    .where(eq(schema.mcpServers.id, id));
  revalidatePath("/admin");
}

export async function setServerAccess(id: string, everyone: boolean, emails: string) {
  await requireAdmin();
  const list = emails
    .split(/[\s,;]+/)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => /^[^@\s]+@[^@\s]+$/.test(e))
    .slice(0, 500);
  await getDb()
    .update(schema.mcpServers)
    .set({ allowedEmails: everyone ? null : list })
    .where(eq(schema.mcpServers.id, id));
  revalidatePath("/admin");
}

export async function searchConnectorCatalog(query: string) {
  await requireAdmin();
  return searchCatalog(String(query ?? ""));
}
