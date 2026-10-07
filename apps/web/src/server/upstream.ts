import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { inArray } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { open } from "@/lib/secret-box";
import { StoredOAuthProvider, usesOAuth } from "./connector-oauth";
import { safeFetch } from "./safe-fetch";

export type UpstreamServer = typeof schema.mcpServers.$inferSelect;

export type UpstreamTool = {
  name: string;
  description?: string;
  inputSchema: { type: "object"; [key: string]: unknown };
};

const CACHE_MS = 5 * 60 * 1000;
const toolCache = new Map<string, { at: number; tools: UpstreamTool[] }>();

async function connect(server: UpstreamServer) {
  const headers: Record<string, string> = {};
  if (server.headerName && server.headerValue) headers[server.headerName] = open(server.headerValue);
  const client = new Client({ name: "understudy-gatekeeper", version: "1.0.0" });
  const authProvider = usesOAuth(server) ? new StoredOAuthProvider(server) : undefined;
  const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers, redirect: "error" }, fetch: safeFetch, authProvider });
  await client.connect(transport);
  return client;
}

export async function loadServers(ids: string[]) {
  if (ids.length === 0) return [];
  return getDb().select().from(schema.mcpServers).where(inArray(schema.mcpServers.id, ids));
}

export async function listUpstreamTools(server: UpstreamServer): Promise<UpstreamTool[]> {
  const cached = toolCache.get(server.id);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.tools;
  const client = await connect(server);
  try {
    const result = await client.listTools();
    const tools = result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as UpstreamTool["inputSchema"],
    }));
    toolCache.set(server.id, { at: Date.now(), tools });
    return tools;
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function callUpstreamTool(server: UpstreamServer, name: string, args: Record<string, unknown>) {
  const client = await connect(server);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close().catch(() => undefined);
  }
}

export function forgetServer(id: string) {
  toolCache.delete(id);
}

export function slugify(name: string) {
  return (
    name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 24) || "tools"
  );
}

export type ConnectorProblem = "unauthorized" | "not_found" | "private" | "unreachable" | "not_mcp";

export function connectorProblem(error: unknown): ConnectorProblem {
  const code = (error as { code?: unknown })?.code;
  const message = String((error as Error)?.message ?? error);
  if (code === 401 || code === 403 || /\b(401|403)\b|unauthori[sz]ed|forbidden/i.test(message)) return "unauthorized";
  if (code === 404 || /\b404\b|not found/i.test(message)) return "not_found";
  if (code === "EPRIVATEADDR" || /private (address|host)|unsupported protocol/i.test(message)) return "private";
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|aborted|timeout|certificate/i.test(message) || typeof code === "string") return "unreachable";
  return "not_mcp";
}

export async function testConnection(server: UpstreamServer): Promise<{ ok: true; tools: UpstreamTool[] } | { ok: false; problem: ConnectorProblem }> {
  forgetServer(server.id);
  try {
    return { ok: true, tools: await listUpstreamTools(server) };
  } catch (error) {
    console.error(JSON.stringify({ event: "mcp_server_test_failed", url: server.url, error: String(error) }));
    return { ok: false, problem: connectorProblem(error) };
  }
}
