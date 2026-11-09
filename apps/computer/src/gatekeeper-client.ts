import { gatekeeperUrl } from "./endpoints.ts";

export type McpSession = { call: (name: string, args: Record<string, unknown>) => Promise<string> };

function parseRpc(body: string, contentType: string, id: number): any {
  const messages = contentType.includes("text/event-stream")
    ? body
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => {
          try {
            return JSON.parse(line.slice(5).trim());
          } catch {
            return null;
          }
        })
    : [JSON.parse(body)];
  return messages.flat().find((message) => message && message.id === id);
}

export async function openGatekeeper(serverUrl: string, token: string, signal?: AbortSignal): Promise<McpSession> {
  const url = gatekeeperUrl(serverUrl);
  let sessionId: string | null = null;
  let next = 0;
  const post = async (message: Record<string, unknown>) => {
    const response = await fetch(url, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      },
      body: JSON.stringify(message),
    });
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    return { body: await response.text(), contentType: response.headers.get("content-type") ?? "", status: response.status };
  };
  const request = async (method: string, params: Record<string, unknown>) => {
    const id = ++next;
    const reply = await post({ jsonrpc: "2.0", id, method, params });
    if (reply.status >= 400) throw new Error(`gatekeeper answered HTTP ${reply.status}`);
    const message = parseRpc(reply.body, reply.contentType, id);
    if (!message) throw new Error("gatekeeper sent no answer");
    if (message.error) throw new Error(message.error.message ?? "gatekeeper error");
    return message.result;
  };
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "understudy-fake-brain", version: "1" } });
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  return {
    async call(name, args) {
      const result = await request("tools/call", { name, arguments: args });
      return (result?.content ?? []).map((part: { text?: string }) => part.text ?? "").join("\n");
    },
  };
}


export type ApprovalRequest = { summary: string; fields: { label: string; value: string }[]; runId?: string; stepId?: string; site?: string };

export type OwnerAnswer = { approved: boolean; pending: boolean; text: string; requestId?: string };

export function readOwnerAnswer(text: string, knownRequestId?: string): OwnerAnswer {
  const requestId = text.match(/request_?id\W{1,8}([A-Za-z0-9_-]{4,})/i)?.[1] ?? knownRequestId;
  return { approved: /^\s*approved/i.test(text), pending: /status\W{1,8}pending/i.test(text), text, ...(requestId ? { requestId } : {}) };
}

export async function askOwnerOnce(session: McpSession, request: ApprovalRequest, knownRequestId?: string): Promise<OwnerAnswer> {
  if (knownRequestId) {
    const text = await session.call("wait_for_approval", { requestId: knownRequestId });
    if (!/unknown request/i.test(text)) return readOwnerAnswer(text, knownRequestId);
  }
  const text = await session.call("request_approval", { summary: request.summary, fields: request.fields, ...(request.runId ? { runId: request.runId } : {}), ...(request.stepId ? { stepId: request.stepId } : {}), ...(request.site ? { site: request.site } : {}) });
  return readOwnerAnswer(text);
}

export async function requestOwnerApproval(session: McpSession, request: ApprovalRequest): Promise<OwnerAnswer> {
  let answer = await askOwnerOnce(session, request);
  while (answer.pending && answer.requestId) answer = await askOwnerOnce(session, request, answer.requestId);
  return answer;
}

export type RunApproval = { requestId: string; stepId?: string | null; summary: string; status?: string; note?: string; expiresAt?: string | null };

export type RunApprovalList = { pending: RunApproval[]; answered: RunApproval[] };

export async function listRunApprovals(session: McpSession, runId: string, wait: boolean): Promise<RunApprovalList> {
  const text = await session.call("run_approvals", { runId, ...(wait ? { wait: true } : {}) });
  if (/^unknown tool/i.test(text)) return { pending: [], answered: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`the panel did not list the run's approvals: ${text.slice(0, 200)}`);
  }
  const list = parsed as Partial<RunApprovalList>;
  if (!Array.isArray(list.pending) || !Array.isArray(list.answered)) throw new Error("the panel sent an unexpected list of approvals");
  return { pending: list.pending, answered: list.answered };
}
