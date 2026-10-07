import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { argsSubject, describeRule, findViolation, formatBytes } from "@understudy/protocol";
import { getDb, schema } from "@/lib/db";
import type { AgentTools } from "@/lib/db/schema";
import { brainText } from "@/lib/brain-text";
import { hashToken, newId } from "@/lib/ids";
import type { ComputerReply, Hub } from "./hub";
import { approvalFields, payloadHash, serverAllowedFor } from "./approval-payload";
import { teamTools } from "./team";
import { taskTools } from "./task-tools";
import { reportRuleBlock } from "./rules";
import { agentIdentity, slackEnabled } from "./slack";
import { slackApi, slackMode, slackTools, type GuardInput, type GuardResult } from "./slack-tools";
import { callUpstreamTool, listUpstreamTools, loadServers, type UpstreamServer } from "./upstream";

const APPROVAL_LIFETIME_SECONDS = 24 * 60 * 60;
const APPROVAL_CALL_CAP_MS = 30 * 60 * 1000;
const HEARTBEAT_MS = 20_000;

type AgentRow = typeof schema.agents.$inferSelect;

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function decision(approved: boolean, note: string | undefined, requestId: string, stopped = false): ToolResult {
  const verdict = approved ? "approved" : stopped ? "stopped" : "denied";
  return text(`${note ? `${verdict}: ${note}` : verdict} [requestId: ${requestId}]`);
}

type Outcome = { kind: "unknown" } | { kind: "pending" } | { kind: "decided"; approved: boolean; note?: string; stopped?: boolean };

const MAX_BODY_BYTES = 1024 * 1024;

function outcomeText(id: string, outcome: Outcome): ToolResult {
  if (outcome.kind === "unknown") return text("denied: unknown request");
  if (outcome.kind === "pending") return text(JSON.stringify({ status: "pending", requestId: id }));
  return decision(outcome.approved, outcome.note, id, outcome.stopped);
}

function text(value: unknown, isError = false): ToolResult {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], isError };
}

async function logCall(agentId: string, tool: string, args: unknown, result: unknown, ok: boolean) {
  await getDb().insert(schema.toolCalls).values({ id: newId("tc"), agentId, tool, args, result, ok });
  console.log(JSON.stringify({ at: new Date().toISOString(), event: "gatekeeper_call", agentId, tool, ok }));
}

type Extra = {
  signal: AbortSignal;
  sendNotification: (notification: { method: "notifications/message"; params: { level: "info"; data: unknown } }) => Promise<void>;
};

export function toolsEnabled(tools: AgentTools) {
  return {
    request_approval: true,
    wait_for_approval: true,
    notify_owner: tools.notifyOwner,
  };
}

type Builtin = {
  name: string;
  description: string;
  schema: z.ZodType;
  run: (args: never, extra: Extra) => Promise<ToolResult>;
};

const PROXY_SEPARATOR = "__";

function jsonSchemaOf(schema: z.ZodType) {
  const { $schema, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest as { type: "object"; [key: string]: unknown };
}

async function buildServer(hub: Hub, agent: AgentRow, ownerEmail: string) {
  const server = new Server({ name: "understudy-gatekeeper", version: "1.0.0" }, { capabilities: { tools: {}, logging: {} } });
  const enabled = toolsEnabled(agent.tools);
  const askTools = new Set(agent.tools.askTools ?? []);

  const waitOutcome = async (id: string, extra: Extra): Promise<Outcome> => {
    const heartbeat = setInterval(() => {
      extra
        .sendNotification({ method: "notifications/message", params: { level: "info", data: "waiting for owner" } })
        .catch(() => undefined);
    }, HEARTBEAT_MS);
    try {
      const existing = await hub.approvalOutcome(id, agent.id);
      if (!existing) return { kind: "unknown" };
      if (existing.status === "expired") return { kind: "decided", approved: false, note: brainText.expiredNote };
      if (existing.status === "cancelled") return { kind: "decided", approved: false, note: brainText.stoppedNote, stopped: true };
      if (existing.status !== "pending") return { kind: "decided", approved: existing.status === "approved", note: existing.note ?? undefined };
      const answer = await hub.waitForApproval(id, APPROVAL_CALL_CAP_MS);
      if (!answer) return { kind: "pending" };
      return { kind: "decided", approved: answer.approved, note: answer.note, stopped: answer.status === "cancelled" };
    } finally {
      clearInterval(heartbeat);
    }
  };

  const waitWithHeartbeat = async (id: string, extra: Extra) => outcomeText(id, await waitOutcome(id, extra));

  const builtins: Builtin[] = [
    {
      name: "request_approval",
      description:
        'Ask your owner to approve a step that cannot be undone, before doing it. Returns "approved" or "denied" (with an optional note from the owner). If it returns {"status":"pending","requestId":...}, the owner has not answered yet: call wait_for_approval with that requestId and keep waiting. Never do the step unless the answer is approved.',
      schema: z.object({
        summary: z.string().min(1).max(500),
        fields: z.array(z.object({ label: z.string().max(200), value: z.string().max(20000) })).max(50).optional(),
        runId: z.string().optional(),
        stepId: z.string().optional(),
      }),
      run: (async (args: { summary: string; fields?: { label: string; value: string }[]; runId?: string; stepId?: string }, extra: Extra) => {
        const id = await hub.createApproval(
          agent.id,
          { summary: args.summary, fields: args.fields ?? [], runId: args.runId || undefined, stepId: args.stepId },
          "mcp",
          APPROVAL_LIFETIME_SECONDS,
        );
        return waitWithHeartbeat(id, extra);
      }) as Builtin["run"],
    },
    {
      name: "wait_for_approval",
      description: "Keep waiting for an approval that came back pending. Returns approved, denied, or pending again.",
      schema: z.object({ requestId: z.string().min(1) }),
      run: (async (args: { requestId: string }, extra: Extra) => waitWithHeartbeat(args.requestId, extra)) as Builtin["run"],
    },
  ];

  builtins.push({
    name: "share_file",
    description:
      "Send a file from your computer to your owner in the chat, as a card with a preview (images, video and audio players, PDFs, text and code) and a download button. Use it for anything you made or found for your owner. path: the file on your computer (absolute, ~/..., or relative to ~/files); files outside ~/files/inbox and ~/files/outbox are copied into ~/files/outbox first. caption: an optional short message shown with the file.",
    schema: z.object({ path: z.string().min(1).max(1000), caption: z.string().max(4000).optional() }),
    run: (async (args: { path: string; caption?: string }) => {
      const result = await hub.askComputer<Extract<ComputerReply, { type: "file_shared" }>>(agent.id, { type: "file_share", requestId: newId("share"), path: args.path }, 10 * 60 * 1000);
      if (result.type === "failed") return text(`not shared: ${result.error === "offline" ? "your computer is not connected to the panel" : "the copy took too long"}`, true);
      if (result.error || !result.attachment) return text(`not shared: ${result.error ?? "unknown error"}`, true);
      await hub.addMessage(agent.id, "agent", (args.caption ?? "").trim().slice(0, 4000), null, undefined, undefined, undefined, [result.attachment]);
      return text(`shared "${result.attachment.name}" (${formatBytes(result.attachment.size)}) with your owner; it is in the chat as ~/files/${result.attachment.path}. Do not paste its contents again.`);
    }) as Builtin["run"],
  });

  if (enabled.notify_owner) {
    builtins.push({
      name: "notify_owner",
      description: "Send a short message to your owner (panel chat, and Slack DM when available). Does not wait for an answer.",
      schema: z.object({ text: z.string().min(1).max(2000) }),
      run: (async (args: { text: string }) => {
        const result = await hub.notifyOwner(agent.id, args.text);
        return text({ delivered: true, slack: result.slack });
      }) as Builtin["run"],
    });
  }

  builtins.push(...(teamTools(hub, agent) as Builtin[]));
  builtins.push(...(taskTools(hub, agent) as Builtin[]));

  const guard = (input: GuardInput) =>
    guardOutward(hub, agent, input.target, input.summary, input.fields, input.args, input.ask, waitOutcome, input.extra as Extra);

  if (await slackEnabled()) {
    builtins.push(
      ...(slackTools({
        agent: { id: agent.id, name: agent.name, iconUrl: agentIdentity(agent).iconUrl },
        mode: slackMode(agent.tools),
        api: slackApi(),
        guard,
        fetchFile: (path) => hub.requestFile(agent.id, path),
      }) as Builtin[]),
    );
  }

  const upstreams = (await loadServers(agent.tools.servers ?? [])).filter((server) => serverAllowedFor(server.allowedEmails, ownerEmail));
  const needsApproval = (upstream: UpstreamServer, toolName: string) =>
    upstream.askAll || (upstream.askTools ?? []).includes(toolName) || askTools.has(`${upstream.id}:${toolName}`);

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const proxied = await Promise.all(
      upstreams.map(async (upstream) => {
        try {
          const tools = await listUpstreamTools(upstream);
          return tools.map((tool) => ({
            name: `${upstream.slug}${PROXY_SEPARATOR}${tool.name}`,
            description: `[${upstream.name}] ${tool.description ?? ""}${needsApproval(upstream, tool.name) ? " (the owner approves every call; it may take a while)" : ""}`.trim(),
            inputSchema: tool.inputSchema,
          }));
        } catch (error) {
          console.error(JSON.stringify({ event: "upstream_list_error", server: upstream.slug, error: String(error) }));
          return [];
        }
      }),
    );
    return {
      tools: [
        ...builtins.map((b) => ({ name: b.name, description: b.description, inputSchema: jsonSchemaOf(b.schema) })),
        ...proxied.flat(),
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const builtin = builtins.find((b) => b.name === name);
    try {
      let result: ToolResult;
      if (builtin) {
        const parsed = builtin.schema.safeParse(args);
        result = parsed.success ? await builtin.run(parsed.data as never, extra as unknown as Extra) : text(parsed.error.message, true);
      } else {
        const [slug, ...rest] = name.split(PROXY_SEPARATOR);
        const toolName = rest.join(PROXY_SEPARATOR);
        const upstream = upstreams.find((u) => u.slug === slug);
        if (!upstream || !toolName) {
          result = text(`unknown tool ${name}`, true);
        } else {
          result = await proxyCall(hub, agent, upstream, toolName, args, needsApproval(upstream, toolName), waitOutcome, extra as unknown as Extra);
        }
      }
      await logCall(agent.id, name, args, result.content[0]?.text?.slice(0, 4000), !result.isError);
      return result;
    } catch (error) {
      await logCall(agent.id, name, args, String(error), false);
      return text(String(error), true);
    }
  });

  return server;
}

async function guardOutward(
  hub: Hub,
  agent: AgentRow,
  target: string,
  summary: string,
  fields: { label: string; value: string }[],
  args: Record<string, unknown>,
  ask: boolean,
  waitOutcome: (id: string, extra: Extra) => Promise<Outcome>,
  extra: Extra,
): Promise<GuardResult> {
  const violation = findViolation(agent.rules ?? [], argsSubject(args));
  if (violation) {
    const rule = describeRule(violation.rule);
    await reportRuleBlock(hub, agent.id, rule, violation.reason).catch(() => {});
    return { ok: false, text: `not done: blocked by your owner's rule "${rule}": ${violation.reason}. Do not try another way; stop and tell your owner.` };
  }
  if (!ask) return { ok: true };
  const hash = payloadHash(target, args);
  const id = await hub.createApproval(agent.id, { summary, fields }, "mcp", APPROVAL_LIFETIME_SECONDS, hash);
  let outcome = await waitOutcome(id, extra);
  while (outcome.kind === "pending" && !extra.signal?.aborted) outcome = await waitOutcome(id, extra);
  if (outcome.kind !== "decided" || !outcome.approved) return { ok: false, text: `not done: the owner ${outcomeText(id, outcome).content[0].text}` };
  const approvedHash = await hub.approvalPayloadHash(id, agent.id);
  if (!approvedHash || approvedHash !== payloadHash(target, args)) return { ok: false, text: "not done: the arguments differ from what the owner approved" };
  return { ok: true };
}

async function proxyCall(
  hub: Hub,
  agent: AgentRow,
  upstream: UpstreamServer,
  toolName: string,
  args: Record<string, unknown>,
  needsApproval: boolean,
  waitOutcome: (id: string, extra: Extra) => Promise<Outcome>,
  extra: Extra,
): Promise<ToolResult> {
  const shown = needsApproval ? approvalFields(args) : { fields: [] };
  if ("error" in shown) {
    return text(`not called: calls that need approval need ${shown.error}, so the owner sees exactly what will run`, true);
  }
  const allowed = await guardOutward(hub, agent, `${upstream.id}:${toolName}`, `${upstream.name}: ${toolName}`, [...shown.fields], args, needsApproval, waitOutcome, extra);
  if (!allowed.ok) return text(allowed.text.replace(/^not done:/, "not called:"), true);
  const result = await callUpstreamTool(upstream, toolName, args);
  const content = Array.isArray(result.content) ? result.content : [];
  const parts = content.map((part: { type: string; text?: string }) => (part.type === "text" ? part.text ?? "" : JSON.stringify(part)));
  return text(parts.join("\n") || JSON.stringify(result), Boolean(result.isError));
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("body_too_large");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

function reject(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

export async function authenticateComputer(authorization: string | undefined) {
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) return null;
  const [row] = await getDb()
    .select({ agent: schema.agents, ownerStatus: schema.user.status, ownerEmail: schema.user.email })
    .from(schema.agents)
    .innerJoin(schema.user, eq(schema.user.id, schema.agents.ownerId))
    .where(eq(schema.agents.tokenHash, hashToken(token)));
  if (!row || row.ownerStatus !== "approved") return null;
  return { ...row.agent, ownerEmail: row.ownerEmail };
}

export async function handleGatekeeper(hub: Hub, req: IncomingMessage, res: ServerResponse) {
  const agent = await authenticateComputer(req.headers.authorization);
  if (!agent) return reject(res, 401, "unauthorized");
  if (req.method !== "POST") return reject(res, 405, "method not allowed");
  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    return reject(res, 400, "invalid json");
  }
  const server = await buildServer(hub, agent, agent.ownerEmail);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close().catch(() => undefined);
    server.close().catch(() => undefined);
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
