import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const url = process.env.TEST_DATABASE_URL;
const skip = !url && "set TEST_DATABASE_URL to a disposable Postgres to run";
if (url) process.env.DATABASE_URL = url;
process.env.BETTER_AUTH_SECRET ??= "test-secret";
process.env.UNDERSTUDY_ALLOW_PRIVATE_MCP = "1";

const ids = {
  owner: "usr_tp_owner",
  approver: "usr_tp_approver",
  admin: "usr_tp_admin",
  agent: "agt_tp",
  server: "mcp_tp",
};
const token = "ust_tool_permissions_test_token";
const calls: { tool: string; args: Record<string, unknown> }[] = [];
let upstream: Server;
let panel: Server;
let panelUrl = "";

function listen(server: Server) {
  return new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

async function mcp(method: string, params: Record<string, unknown>) {
  const res = await fetch(`${panelUrl}/api/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)))
    .find((m) => m.id === 1)?.result;
}

async function call(name: string, args: Record<string, unknown>) {
  return (await mcp("tools/call", { name, arguments: args }))?.content?.[0]?.text as string;
}

async function listed() {
  return ((await mcp("tools/list", {}))?.tools ?? []) as { name: string; description: string }[];
}

async function pendingApproval() {
  const { getDb, schema } = await import("@/lib/db");
  for (let i = 0; i < 100; i++) {
    const [pending] = await getDb()
      .select()
      .from(schema.approvals)
      .where(and(eq(schema.approvals.agentId, ids.agent), eq(schema.approvals.status, "pending")));
    if (pending) return pending;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("no pending approval");
}

async function lastCall() {
  const { getDb, schema } = await import("@/lib/db");
  const rows = await getDb().select().from(schema.toolCalls).where(eq(schema.toolCalls.agentId, ids.agent));
  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).at(-1);
}

async function setTools(
  toolPolicy: Record<string, Record<string, "allow" | "ask" | "never">>,
  askTools: string[] = [],
  toolHints: Record<string, Record<string, { readOnlyHint?: boolean; destructiveHint?: boolean }>> = {},
) {
  const { getDb, schema } = await import("@/lib/db");
  await getDb()
    .update(schema.agents)
    .set({ tools: { notifyOwner: true, slack: false, slackChannels: [], servers: [ids.server], askTools, toolPolicy, toolHints } })
    .where(eq(schema.agents.id, ids.agent));
}

async function agentPolicy() {
  const { getDb, schema } = await import("@/lib/db");
  const [agent] = await getDb().select({ tools: schema.agents.tools }).from(schema.agents).where(eq(schema.agents.id, ids.agent));
  return agent?.tools.toolPolicy ?? {};
}

before(async () => {
  if (!url) return;
  upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const server = new McpServer({ name: "mail", version: "1" });
    const record = (tool: string) => async (args: Record<string, unknown>) => {
      calls.push({ tool, args });
      return { content: [{ type: "text" as const, text: `${tool} done` }] };
    };
    server.registerTool("search_threads", { description: "Search the mailbox", inputSchema: { query: z.string() }, annotations: { readOnlyHint: true } }, record("search_threads"));
    server.registerTool("create_draft", { description: "Write a draft\nfor the owner to send", inputSchema: { to: z.string(), body: z.string() }, annotations: { readOnlyHint: false, destructiveHint: false } }, record("create_draft"));
    server.registerTool("trash_message", { description: "Move a message to the trash", inputSchema: { id: z.string() }, annotations: { destructiveHint: true } }, record("trash_message"));
    server.registerTool("label_message", { description: "Add a label", inputSchema: { id: z.string() } }, record("label_message"));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  const upstreamUrl = await listen(upstream);
  const { getDb, schema } = await import("@/lib/db");
  const { hashToken } = await import("@/lib/ids");
  const db = getDb();
  await (await import("./test-db")).migrateTestDb();
  await db.delete(schema.mcpServers).where(eq(schema.mcpServers.id, ids.server));
  await db.delete(schema.user).where(inArray(schema.user.id, Object.values(ids)));
  await db.insert(schema.user).values([
    { id: ids.owner, name: "Owner", email: "tp-owner@test.local", status: "approved" },
    { id: ids.approver, name: "Approver", email: "tp-approver@test.local", status: "approved" },
    { id: ids.admin, name: "Admin", email: "tp-admin@test.local", status: "approved", admin: true },
  ]);
  await db.insert(schema.mcpServers).values({ id: ids.server, name: "Mail", slug: "mail", url: `${upstreamUrl}/mcp` });
  await db.insert(schema.agents).values({
    id: ids.agent,
    ownerId: ids.owner,
    name: "TP",
    look: { body: "pill", color: "#7FB2FF", eyes: "dot", acc: "none", accColor: "#2F3A56" },
    tokenHash: hashToken(token),
    tools: { notifyOwner: true, slack: false, slackChannels: [], servers: [ids.server], askTools: [] },
  } as never);
  await db.insert(schema.agentMembers).values({ agentId: ids.agent, userId: ids.approver, role: "approver" });

  const { createHub } = await import("./hub");
  const { handleGatekeeper } = await import("./gatekeeper");
  const hub = createHub();
  panel = createServer((req, res) => {
    if (new URL(req.url ?? "/", "http://x").pathname === "/api/mcp") return void handleGatekeeper(hub, req, res);
    res.writeHead(404);
    res.end();
  });
  panelUrl = await listen(panel);
});

beforeEach(async () => {
  if (!url) return;
  const { getDb, schema } = await import("@/lib/db");
  const db = getDb();
  calls.length = 0;
  await db.delete(schema.approvals).where(eq(schema.approvals.agentId, ids.agent));
  await db.delete(schema.toolCalls).where(eq(schema.toolCalls.agentId, ids.agent));
  await db.delete(schema.runs).where(eq(schema.runs.agentId, ids.agent));
  await db.delete(schema.mcpToolLimits).where(eq(schema.mcpToolLimits.serverId, ids.server));
  await db.update(schema.mcpServers).set({ askAll: false, askTools: [] }).where(eq(schema.mcpServers.id, ids.server));
  await setTools({});
});

after(async () => {
  if (!url) return;
  const { getDb, schema, getPool } = await import("@/lib/db");
  await getDb().delete(schema.mcpServers).where(eq(schema.mcpServers.id, ids.server));
  await getDb().delete(schema.user).where(inArray(schema.user.id, Object.values(ids)));
  upstream.close();
  panel.close();
  await getPool().end();
  setTimeout(() => process.exit(0), 100).unref();
});

test("by default read-only tools run freely, everything else asks, and nothing is hidden", { skip }, async () => {
  const tools = await listed();
  const byName = new Map(tools.map((t) => [t.name, t.description]));
  assert.ok(byName.has("mail__search_threads"));
  assert.doesNotMatch(byName.get("mail__search_threads") ?? "", /owner approves/);
  for (const name of ["mail__create_draft", "mail__trash_message", "mail__label_message"]) assert.match(byName.get(name) ?? "", /owner approves/, name);

  assert.equal(await call("mail__search_threads", { query: "invoice" }), "search_threads done");
  assert.equal((await lastCall())?.verdict, "allowed");
  assert.equal((await pendingApproval().catch(() => null)) === null, true);
});

test("ask shows the tool, what it does and every argument, and a denial is recorded", { skip }, async () => {
  const { createHub } = await import("./hub");
  const pending = call("mail__trash_message", { id: "msg-42" });
  const approval = await pendingApproval();
  assert.equal(approval.summary, "Use trash_message on Mail");
  const fields = Object.fromEntries(approval.fields.map((f) => [f.label, f.value]));
  assert.equal(fields.Connector, "Mail");
  assert.equal(fields.Action, "trash_message");
  assert.equal(fields["What it does"], "Move a message to the trash");
  assert.match(fields["Heads up"] ?? "", /delete or overwrite/);
  assert.equal(fields.id, "msg-42");
  assert.deepEqual(approval.grant, { serverId: ids.server, tool: "trash_message" });
  await createHub().answerApproval(approval.id, false, undefined, ids.owner);
  assert.match(await pending, /^not called/);
  assert.equal(calls.length, 0);
  assert.equal((await lastCall())?.verdict, "denied");
});

test("approve and always allow runs this call and stops asking for that tool only", { skip }, async () => {
  const { createHub } = await import("./hub");
  const pending = call("mail__create_draft", { to: "client@example.com", body: "Hello" });
  const approval = await pendingApproval();
  await createHub().answerApproval(approval.id, true, undefined, ids.owner, true);
  assert.equal(await pending, "create_draft done");
  assert.equal((await lastCall())?.verdict, "approved");
  assert.deepEqual(await agentPolicy(), { [ids.server]: { create_draft: "allow" } });

  assert.equal(await call("mail__create_draft", { to: "other@example.com", body: "Hi" }), "create_draft done");
  assert.equal((await lastCall())?.verdict, "allowed");
  const other = call("mail__label_message", { id: "msg-7" });
  const second = await pendingApproval();
  assert.match(second.summary, /label_message/);
  await createHub().answerApproval(second.id, false, undefined, ids.owner);
  await other;
});

test("only the owner can turn an approval into always allow", { skip }, async () => {
  const { createHub } = await import("./hub");
  const pending = call("mail__create_draft", { to: "client@example.com", body: "Hello" });
  const approval = await pendingApproval();
  await createHub().answerApproval(approval.id, true, undefined, ids.approver, true);
  assert.equal(await pending, "create_draft done");
  assert.deepEqual(await agentPolicy(), {});
});

test("never hides the tool from the brain and refuses a direct call without reaching the server", { skip }, async () => {
  await setTools({ [ids.server]: { search_threads: "never" } });
  assert.ok(!(await listed()).some((t) => t.name === "mail__search_threads"));
  const result = await call("mail__search_threads", { query: "x" });
  assert.match(result, /^not called: your owner turned off/);
  assert.equal(calls.length, 0);
  assert.equal((await lastCall())?.verdict, "blocked");
  const asked = await call("request_approval", { summary: "Search", action: { tool: "mail__search_threads", args: { query: "x" } } });
  assert.match(asked, /^not asked/);
});

test("the admin ceiling wins over the owner and cannot be loosened by always allow", { skip }, async () => {
  const { getDb, schema } = await import("@/lib/db");
  const { createHub } = await import("./hub");
  await getDb()
    .insert(schema.mcpToolLimits)
    .values([
      { serverId: ids.server, tool: "trash_message", level: "never" },
      { serverId: ids.server, tool: "create_draft", level: "ask" },
    ]);
  await setTools({ [ids.server]: { trash_message: "allow", create_draft: "allow" } });
  assert.ok(!(await listed()).some((t) => t.name === "mail__trash_message"));
  assert.match(await call("mail__trash_message", { id: "1" }), /^not called/);

  const pending = call("mail__create_draft", { to: "a@example.com", body: "b" });
  const approval = await pendingApproval();
  assert.equal(approval.grant, null);
  await createHub().answerApproval(approval.id, true, undefined, ids.owner, true);
  assert.equal(await pending, "create_draft done");
  assert.deepEqual(await agentPolicy(), { [ids.server]: { trash_message: "allow", create_draft: "allow" } });
  assert.equal(calls.filter((c) => c.tool === "trash_message").length, 0);
});

test("ask-all on the connector makes even read-only tools ask", { skip }, async () => {
  const { getDb, schema } = await import("@/lib/db");
  const { createHub } = await import("./hub");
  await getDb().update(schema.mcpServers).set({ askAll: true }).where(eq(schema.mcpServers.id, ids.server));
  const pending = call("mail__search_threads", { query: "x" });
  const approval = await pendingApproval();
  await createHub().answerApproval(approval.id, true, undefined, ids.owner);
  assert.equal(await pending, "search_threads done");
  assert.equal((await lastCall())?.verdict, "approved");
});

test("an older per-understudy ask-first choice still asks", { skip }, async () => {
  const { createHub } = await import("./hub");
  await setTools({}, [`${ids.server}:search_threads`]);
  const pending = call("mail__search_threads", { query: "x" });
  const approval = await pendingApproval();
  await createHub().answerApproval(approval.id, false, undefined, ids.owner);
  await pending;
  assert.equal(calls.length, 0);
});

test("calls during a task run are recorded on that run with their verdict", { skip }, async () => {
  const { getDb, schema } = await import("@/lib/db");
  const { createHub } = await import("./hub");
  const runId = "run_tp_history";
  await getDb().insert(schema.runs).values({ id: runId, agentId: ids.agent, trigger: "manual", status: "running" });
  await call("mail__search_threads", { query: "x" });
  const pending = call("mail__label_message", { id: "9" });
  const approval = await pendingApproval();
  assert.equal(approval.runId, runId);
  await createHub().answerApproval(approval.id, false, undefined, ids.owner);
  await pending;
  const rows = await getDb().select().from(schema.toolCalls).where(eq(schema.toolCalls.runId, runId));
  assert.deepEqual(rows.map((r) => [r.tool, r.verdict]).sort(), [
    ["mail__label_message", "denied"],
    ["mail__search_threads", "allowed"],
  ]);
});

test("a tool name the connector did not list is refused without asking or reaching the server", { skip }, async () => {
  const { getDb, schema } = await import("@/lib/db");
  await getDb().insert(schema.mcpToolLimits).values({ serverId: ids.server, tool: "trash_message", level: "never" });
  const result = call("mail__Trash_Message", { id: "1" });
  assert.equal(await pendingApproval().catch(() => null), null);
  assert.match(await result, /^not called: Mail does not list Trash_Message/);
  assert.equal(calls.length, 0);
  assert.equal((await lastCall())?.verdict, "blocked");
  const asked = await call("request_approval", { summary: "Trash", action: { tool: "mail__Trash_Message", args: { id: "1" } } });
  assert.match(asked, /^not asked/);
});

test("a tool that now claims to be read-only keeps asking when it was a write tool when first seen", { skip }, async () => {
  const { createHub } = await import("./hub");
  await setTools({}, [], { [ids.server]: { search_threads: { readOnlyHint: false } } });
  assert.match((await listed()).find((t) => t.name === "mail__search_threads")?.description ?? "", /owner approves/);
  const pending = call("mail__search_threads", { query: "x" });
  const approval = await pendingApproval();
  await createHub().answerApproval(approval.id, false, undefined, ids.owner);
  assert.match(await pending, /^not called/);
  assert.equal(calls.length, 0);
});
