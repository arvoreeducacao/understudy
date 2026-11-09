import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { and, desc, eq, gte, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { allowedHost, argsSubject, cleanApprovalPolicy, describeRule, effectiveApprovalMode, findViolation, formatBytes, listCoversActions, toolListed } from "@understudy/protocol";
import { getDb, schema } from "@/lib/db";
import { storableJson } from "@/lib/db/storable";
import { MACHINE_ANSWERS, type AgentTools, type ApprovalGrant, type ApprovalVia } from "@/lib/db/schema";
import { messages } from "@/lib/messages";
import { canAlwaysAllow, effectivePermission, hintsRecordedFor, isDestructive, isReadOnly, oneLine, recordedHints, seenHintsFor, trustedHints, type ConnectorCeiling, type ToolPermission, type ToolVerdict } from "@/lib/tool-policy";
import { ceilingForAgent, isSlackProfile } from "@/lib/slack-profile";
import { brainText } from "@/lib/brain-text";
import { hashToken, newId } from "@/lib/ids";
import type { ComputerReply, Hub } from "./hub";
import { approvalFields, MAX_APPROVAL_FIELDS, payloadHash, serverAllowedFor, teamConnector } from "./approval-payload";
import { publishArtifact } from "./artifacts/service";
import { teamTools } from "./team";
import { taskTools } from "./task-tools";
import { followupTools } from "./followup-tools";
import { turnKnown, turnRunId, turnUntrusted, turnWakesFollowup } from "./followups";
import { untrustedTurnFor } from "./approval-modes";
import { autoReview } from "./auto-review";
import { withoutForeignReviewer } from "./reviewer";
import { reportRuleBlock } from "./rules";
import { agentIdentity, slackEnabled, slackUserIdFor } from "./slack";
import { SLACK_LIMITS, slackApi, slackMode, slackTools, type GuardInput, type GuardResult } from "./slack-tools";
import { callUpstreamTool, ceilingOf, listUpstreamTools, loadServers, loadToolLimits, type UpstreamServer, type UpstreamTool } from "./upstream";
import { queueReplyFile } from "./channels/relay";
import { OUTSIDER_TOOLS, outsiderLabel, outsiderTurn } from "./channels/turns";
import { guestTurn } from "./slack-askers";
import { usesGithubApp } from "./github-app";
import { gitPushApproval, type GitAccess, type GitPush, type PushGate } from "./git-proxy";
import { RateLimiter } from "./rate-limit";

const outsiderLimiter = new RateLimiter();
const slackProfileLimiter = new RateLimiter();

const APPROVAL_LIFETIME_SECONDS = 24 * 60 * 60;
const APPROVAL_CALL_CAP_MS = 30 * 60 * 1000;
const ACTION_APPROVAL_MAX_AGE_MS = 15 * 60 * 1000;
const HEARTBEAT_MS = 20_000;

type AgentRow = typeof schema.agents.$inferSelect;

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean; verdict?: ToolVerdict };

type MachineAnswer = (typeof MACHINE_ANSWERS)[number];

function machineAnswer(via: ApprovalVia | null | undefined): MachineAnswer | undefined {
  return MACHINE_ANSWERS.find((machine) => machine === via);
}

function decision(approved: boolean, note: string | undefined, requestId: string, stopped = false, by?: MachineAnswer): ToolResult {
  const verdict = approved ? "approved" : stopped ? "stopped" : "denied";
  return text(`${note ? `${verdict}: ${note}` : verdict} [requestId: ${requestId}]${approved && by ? ` [answeredBy: ${by}]` : ""}`);
}

type Outcome = { kind: "unknown" } | { kind: "pending"; inRun: boolean } | { kind: "decided"; approved: boolean; note?: string; stopped?: boolean; by?: MachineAnswer };

const MAX_BODY_BYTES = 1024 * 1024;

function outcomeText(id: string, outcome: Outcome): ToolResult {
  if (outcome.kind === "unknown") return text("denied: unknown request");
  if (outcome.kind === "pending") return text(JSON.stringify({ status: "pending", requestId: id, note: outcome.inRun ? brainText.pendingNote : brainText.pendingNoteOutsideRun }));
  return decision(outcome.approved, outcome.note, id, outcome.stopped, outcome.by);
}

export function ownerSlackNote(error: string | undefined) {
  if (error === "user_not_found") return brainText.ownerSlackMissing;
  if (error === "slack_disabled") return brainText.ownerSlackOff;
  return brainText.ownerSlackFailed(error ?? "unknown error");
}

function text(value: unknown, isError = false): ToolResult {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], isError };
}

export async function runningRun(agentId: string) {
  const [run] = await getDb()
    .select({ id: schema.runs.id, trigger: schema.runs.trigger, startedAt: schema.runs.startedAt, status: schema.runs.status })
    .from(schema.runs)
    .where(and(eq(schema.runs.agentId, agentId), eq(schema.runs.status, "running")))
    .orderBy(
      sql`greatest("runs"."started_at", coalesce((select max(m.created_at) from messages m where m.agent_id = "runs"."agent_id" and m.run_id = "runs"."id" and m.role in ('activity', 'agent')), "runs"."started_at")) desc`,
      desc(schema.runs.startedAt),
    )
    .limit(1);
  return run ?? null;
}

export async function runningRunId(agentId: string) {
  return (await runningRun(agentId))?.id ?? null;
}

export async function turnRun(agentId: string) {
  const runId = await turnRunId(agentId, runningRunId);
  if (!runId) return null;
  const [run] = await getDb()
    .select({ id: schema.runs.id, trigger: schema.runs.trigger, startedAt: schema.runs.startedAt, status: schema.runs.status })
    .from(schema.runs)
    .where(and(eq(schema.runs.id, runId), eq(schema.runs.agentId, agentId)));
  return run ?? null;
}

const cancels = new Map<string, AbortController>();

function cancelKey(agentId: string, requestId: unknown) {
  return `${agentId}:${String(requestId)}`;
}

export function cancelRequests(agentId: string, body: unknown) {
  for (const message of Array.isArray(body) ? body : [body]) {
    const notice = message as { method?: string; params?: { requestId?: unknown } } | null;
    if (notice?.method === "notifications/cancelled" && notice.params?.requestId !== undefined) cancels.get(cancelKey(agentId, notice.params.requestId))?.abort();
  }
}

async function unapprovedAsk(agentId: string, tool: string) {
  const run = await turnRun(agentId);
  if (!run) return null;
  const [latest] = await getDb()
    .select({ id: schema.approvals.id, status: schema.approvals.status })
    .from(schema.approvals)
    .where(
      and(
        eq(schema.approvals.agentId, agentId),
        or(eq(schema.approvals.runId, run.id), and(isNull(schema.approvals.runId), gte(schema.approvals.createdAt, run.startedAt))),
        sql`${schema.approvals.fields} @> ${JSON.stringify([{ label: "Action", value: tool }])}::jsonb`,
      ),
    )
    .orderBy(desc(schema.approvals.createdAt))
    .limit(1);
  return latest && latest.status !== "approved" ? latest : null;
}

async function logCall(agentId: string, tool: string, args: unknown, result: unknown, ok: boolean, verdict?: ToolVerdict, runId?: string | null) {
  await getDb()
    .insert(schema.toolCalls)
    .values({ id: newId("tc"), agentId, tool, args: storableJson(args), result: storableJson(result), ok, verdict: verdict ?? null, runId: runId ?? null })
    .catch((error) => console.error(JSON.stringify({ event: "tool_call_log_error", agentId, tool, error: errorLine(error) })));
  console.log(JSON.stringify({ at: new Date().toISOString(), event: "gatekeeper_call", agentId, tool, ok, ...(verdict ? { verdict } : {}) }));
}

function errorLine(error: unknown) {
  const cause = error instanceof Error && error.cause ? `: ${String(error.cause)}` : "";
  return `${String(error).split("\n")[0]}${cause}`.slice(0, 500);
}

export async function recordFirstHints(agent: Pick<AgentRow, "id" | "tools">, serverId: string, tools: Pick<UpstreamTool, "name" | "annotations">[]) {
  if (tools.length === 0 || hintsRecordedFor(agent.tools.toolHints, serverId)) return;
  const hints = recordedHints(undefined, serverId, tools);
  await getDb()
    .update(schema.agents)
    .set({ tools: sql`jsonb_set(${schema.agents.tools}, '{toolHints}', coalesce(${schema.agents.tools}->'toolHints', '{}'::jsonb) || ${JSON.stringify({ [serverId]: hints })}::jsonb)` })
    .where(and(eq(schema.agents.id, agent.id), sql`not (coalesce(${schema.agents.tools}->'toolHints', '{}'::jsonb) ? ${serverId}::text)`));
  agent.tools = { ...agent.tools, toolHints: { ...(agent.tools.toolHints ?? {}), [serverId]: hints } };
}

async function untrustedTurn(hub: Hub, agent: Pick<AgentRow, "id" | "ownerId">) {
  const flagged = outsiderTurn(agent.id) || guestTurn(agent.id) || turnUntrusted(agent.id) || turnWakesFollowup(agent.id);
  const run = flagged ? null : await turnRun(agent.id);
  return untrustedTurnFor({ ownerId: agent.ownerId, audience: hub.turnAudience(agent.id), flagged: flagged || !turnKnown(agent.id), runTrigger: run?.trigger ?? null });
}

async function approvalMode(hub: Hub, agent: Pick<AgentRow, "id" | "ownerId" | "approvalPolicy">) {
  const policy = cleanApprovalPolicy(agent.approvalPolicy);
  const untrusted = await untrustedTurn(hub, agent);
  return { policy, mode: effectiveApprovalMode(policy.mode, { untrusted }) };
}

export function sitesInFields(fields: { label: string; value: string }[]) {
  return fields
    .filter((field) => field.label === "Page" || field.label === "Request")
    .map((field) => allowedHost(field.value.trim().replace(/^[A-Z]+\s+/, "")))
    .filter((site): site is string => Boolean(site));
}

export function actionToolName(tool: string) {
  return tool.trim().replace(/^mcp__gatekeeper__/, "");
}

export function actionHash(tool: string, args: Record<string, unknown>) {
  return payloadHash(`action:${actionToolName(tool)}`, args);
}

type Extra = {
  call?: { name: string };
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

async function withHeartbeat<T>(extra: Extra, work: () => Promise<T>): Promise<T> {
  const heartbeat = setInterval(() => {
    extra
      .sendNotification({ method: "notifications/message", params: { level: "info", data: "waiting for owner" } })
      .catch(() => undefined);
  }, HEARTBEAT_MS);
  try {
    return await work();
  } finally {
    clearInterval(heartbeat);
  }
}

function untilAborted(signal: AbortSignal | undefined) {
  return new Promise<null>((resolve) => {
    if (signal?.aborted) return resolve(null);
    signal?.addEventListener("abort", () => resolve(null), { once: true });
  });
}

async function closedRunText(hub: Hub, agentId: string, runId: string | null | undefined) {
  if (!runId) return null;
  const summary = await hub.runs.closedRun(agentId, runId);
  return summary === null ? null : brainText.runClosed(summary);
}

function outcomeWaiter(hub: Hub, agentId: string) {
  return (id: string, extra: Extra): Promise<Outcome> =>
    withHeartbeat(extra, async () => {
      const existing = await hub.approvalOutcome(id, agentId);
      if (!existing) return { kind: "unknown" };
      if (existing.status === "expired") return { kind: "decided", approved: false, note: brainText.expiredNote };
      if (existing.status === "cancelled") return { kind: "decided", approved: false, note: brainText.stoppedNote, stopped: true };
      if (existing.status !== "pending") return { kind: "decided", approved: existing.status === "approved", note: existing.note ?? undefined, by: machineAnswer(existing.via) };
      const answer = await Promise.race([hub.waitForApproval(id, APPROVAL_CALL_CAP_MS), untilAborted(extra.signal)]);
      if (!answer) return { kind: "pending", inRun: Boolean(existing.runId) };
      return { kind: "decided", approved: answer.approved, note: answer.note, stopped: answer.status === "cancelled", by: machineAnswer(answer.via) };
    });
}

type RunApprovalRow = Awaited<ReturnType<Hub["runApprovals"]>>[number];

export function runApprovalsView(runId: string, rows: RunApprovalRow[]) {
  const pending = rows.filter((row) => row.status === "pending");
  const answered = rows.filter((row) => row.status !== "pending");
  return {
    runId,
    pending: pending.map((row) => ({ requestId: row.id, stepId: row.stepId, summary: row.summary, expiresAt: row.expiresAt?.toISOString() ?? null })),
    answered: answered.map((row) => ({ requestId: row.id, stepId: row.stepId, summary: row.summary, status: row.status, ...(row.note ? { note: row.note } : {}), answeredAt: row.answeredAt?.toISOString() ?? null, used: Boolean(row.usedAt) })),
  };
}

export async function waitForRunAnswer(hub: Hub, agentId: string, runId: string, signal: AbortSignal | undefined, capMs = APPROVAL_CALL_CAP_MS) {
  const before = await hub.runApprovals(agentId, runId);
  const waiting = before.filter((row) => row.status === "pending");
  if (waiting.length === 0) return before;
  const answers = waiting.map((row) => hub.waitForApproval(row.id, capMs));
  const now = await hub.runApprovals(agentId, runId);
  if (!now.some((row) => row.status === "pending" && waiting.some((open) => open.id === row.id))) return now;
  await Promise.race([...answers, untilAborted(signal)]);
  return hub.runApprovals(agentId, runId);
}

async function connectorAccess(agent: AgentRow, ownerEmail: string, restricted = false) {
  const upstreams = restricted ? [] : (await loadServers(agent.tools.servers ?? [])).filter((server) => serverAllowedFor(server.allowedEmails, ownerEmail) && (!agent.teamId || teamConnector(server)));
  const limits = await loadToolLimits(upstreams.map((upstream) => upstream.id));
  const ceilings = new Map(upstreams.map((upstream) => [upstream.id, ceilingForAgent(ceilingOf(upstream, limits.get(upstream.id)), upstream.url, agent.tools)]));
  const permissionOf = (upstream: UpstreamServer, tool: Pick<UpstreamTool, "name" | "annotations">) =>
    effectivePermission({
      serverId: upstream.id,
      server: ceilings.get(upstream.id) ?? {},
      tool,
      policy: agent.tools.toolPolicy,
      legacyAsk: agent.tools.askTools,
      seen: agent.tools.toolHints,
    }).permission;
  const toolsOf = (upstream: UpstreamServer) => listUpstreamTools(upstream, agent.ownerId);
  const findTool = async (upstream: UpstreamServer, toolName: string) => {
    const tool = (await toolsOf(upstream).catch(() => [] as UpstreamTool[])).find((listed) => listed.name === toolName);
    return tool && { ...tool, annotations: trustedHints(seenHintsFor(agent.tools.toolHints, upstream.id, tool.name), tool.annotations) };
  };
  return { upstreams, ceilings, permissionOf, toolsOf, findTool };
}

async function buildServer(hub: Hub, agent: AgentRow, ownerEmail: string, restricted = false) {
  const outsider = () => restricted || outsiderTurn(agent.id);
  const server = new Server({ name: "understudy-gatekeeper", version: "1.0.0" }, { capabilities: { tools: {}, logging: {} } });
  const enabled = toolsEnabled(agent.tools);

  const waitOutcome = outcomeWaiter(hub, agent.id);

  const waitWithHeartbeat = async (id: string, extra: Extra) => outcomeText(id, await waitOutcome(id, extra));

  const builtins: Builtin[] = [
    {
      name: "request_approval",
      description:
        'Ask your owner to approve a step that cannot be undone, before doing it. Returns "approved" or "denied" (with an optional note from the owner). If it returns {"status":"pending","requestId":...}, the owner has not answered yet: call wait_for_approval with that requestId and keep waiting. Never do the step unless the answer is approved. When the step is one call to another gatekeeper tool during a task run, pass it as action (tool name and the exact arguments) together with runId: the owner sees exactly that call, and once approved, that one call with exactly those arguments goes through without asking again.',
      schema: z.object({
        summary: z.string().min(1).max(500),
        fields: z.array(z.object({ label: z.string().max(200), value: z.string().max(20000) })).max(50).optional(),
        runId: z.string().optional(),
        stepId: z.string().optional(),
        action: z.object({ tool: z.string().min(1).max(200), args: z.record(z.string(), z.unknown()) }).optional(),
        site: z.string().max(253).optional(),
        reviewerAware: z.boolean().optional(),
        everyTime: z.boolean().optional(),
        cut: z.boolean().optional(),
        contentHash: z.string().max(128).optional(),
      }),
      run: (async (
        args: { summary: string; fields?: { label: string; value: string }[]; runId?: string; stepId?: string; action?: { tool: string; args: Record<string, unknown> }; site?: string; reviewerAware?: boolean; everyTime?: boolean; cut?: boolean; contentHash?: string },
        extra: Extra,
      ) => {
        const label = outsider() ? await outsiderLabel(agent.id) : null;
        if (label && !outsiderLimiter.allow(`outsider:${agent.id}`, 1 / 60, 3)) return text(brainText.outsiderBusy, true);
        const { mode } = await approvalMode(hub, agent);
        if (!label && mode === "off" && !args.runId && !(await runningRun(agent.id))) {
          console.log(JSON.stringify({ at: new Date().toISOString(), event: "approval_skipped", agentId: agent.id, mode }));
          return text(brainText.approvalsOff);
        }
        const offered = !label && args.site && listCoversActions(mode) ? allowedHost(args.site) : null;
        const site = offered && sitesInFields(args.fields ?? []).includes(offered) ? offered : null;
        let fields = withoutForeignReviewer(args.fields ?? []);
        let hash: string | undefined;
        let forced = false;
        if (args.action) {
          const tool = actionToolName(args.action.tool);
          if (!(await actionAllowed(tool))) return text(`not asked: ${tool} is not one of your gatekeeper tools; ask without action`, true);
          const shown = approvalFields(args.action.args);
          if ("error" in shown) return text(`not asked: an action needs ${shown.error}, so the owner sees exactly what will run`, true);
          fields = [...fields, { label: "Action", value: tool }, ...withoutForeignReviewer(shown.fields)];
          if (fields.length > MAX_APPROVAL_FIELDS) return text(`not asked: at most ${MAX_APPROVAL_FIELDS} fields and action arguments together`, true);
          hash = actionHash(tool, args.action.args);
          forced = await actionForced(tool);
        }
        const asked = args.runId && !outsider() ? args.runId : undefined;
        const closed = await closedRunText(hub, agent.id, asked);
        if (closed) return text(closed, true);
        const expected = asked ? await turnRunId(agent.id, async () => asked) : null;
        const runId = asked && expected === asked && (await hub.runs.runState(agent.id, asked)) === "running" ? asked : undefined;
        const summary = label ? `${label}${args.summary}`.slice(0, 500) : args.summary;
        const joined = runId ? await hub.openApprovalAsk(agent.id, { runId, stepId: args.stepId, summary, fields, payloadHash: hash }) : null;
        const grant = site ? { host: site } : undefined;
        const everyTime = args.everyTime === true;
        const fromBrowser = Boolean(args.site) || fields.some((field) => ["page", "request"].includes(field.label.trim().toLowerCase()));
        const reviewable = !joined && !forced && !everyTime && mode === "auto" && (args.reviewerAware === true || !fromBrowser);
        const request = {
          summary,
          fields,
          runId,
          stepId: args.stepId,
          ...(args.reviewerAware ? { source: "computer" as const } : {}),
          ...(args.action ? { tool: actionToolName(args.action.tool) } : {}),
          ...(args.cut ? { cut: true } : {}),
          ...(args.contentHash ? { contentHash: args.contentHash } : {}),
        };
        const reviewed = reviewable ? await autoReview(hub, agent, request, { lifetimeSeconds: APPROVAL_LIFETIME_SECONDS, payloadHash: hash, grant }) : null;
        const id =
          joined ??
          (reviewed?.kind === "approved"
            ? reviewed.id
            : await hub.createApproval(agent.id, { summary, fields: reviewed?.fields ?? fields, runId, stepId: args.stepId }, "mcp", APPROVAL_LIFETIME_SECONDS, hash, grant, reviewed?.review));
        return waitWithHeartbeat(id, extra);
      }) as Builtin["run"],
    },
    {
      name: "wait_for_approval",
      description: "Keep waiting for an approval that came back pending. Returns approved, denied, or pending again.",
      schema: z.object({ requestId: z.string().min(1) }),
      run: (async (args: { requestId: string }, extra: Extra) => waitWithHeartbeat(args.requestId, extra)) as Builtin["run"],
    },
    {
      name: "run_approvals",
      description:
        "List the approvals asked during a task run: the ones your owner has not answered yet, and the answers to the others. With wait: true, first wait (up to 30 minutes) until one of the unanswered ones gets an answer.",
      schema: z.object({ runId: z.string().min(1).max(200), wait: z.boolean().optional() }),
      run: (async (args: { runId: string; wait?: boolean }, extra: Extra) => {
        const open = (await hub.runs.runState(agent.id, args.runId)) === "running";
        const rows = args.wait && open ? await withHeartbeat(extra, () => waitForRunAnswer(hub, agent.id, args.runId, extra.signal)) : await hub.runApprovals(agent.id, args.runId);
        return text({ ...runApprovalsView(args.runId, rows), open });
      }) as Builtin["run"],
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
      await hub.addMessage(agent.id, "agent", (args.caption ?? "").trim().slice(0, 4000), null, undefined, undefined, undefined, [result.attachment], undefined, undefined, hub.turnAudience(agent.id));
      await queueReplyFile(agent.id, result.attachment).catch(() => false);
      return text(`shared "${result.attachment.name}" (${formatBytes(result.attachment.size)}) with your owner; it is in the chat as ~/files/${result.attachment.path}. Do not paste its contents again.`);
    }) as Builtin["run"],
  });

  builtins.push({
    name: "publish_artifact",
    description:
      "Show your owner something you made, beside the chat, in a viewer with pages, zoom, download and every version kept. Use it for anything meant to be looked at: a slide deck, a document, a report, a web page, a chart, a small interactive app, a PDF or an image. Supported: one self-contained .html file (it runs isolated, with no network: inline your data, scripts and styles may only load from cdnjs.cloudflare.com, cdn.jsdelivr.net or unpkg.com, and localStorage, cookies, fetch, forms, popups and links that leave the page do not work), .md, .pdf, .pptx, .docx, .xlsx (shown as pages) and images (.png, .jpg, .webp, .gif, .svg). path: the file on your computer. title: a short human name. To change an artifact, edit the file and call this again with its artifact_id; that adds a new version. note: one short line saying what this version is or what changed.",
    schema: z.object({
      path: z.string().min(1).max(1000),
      title: z.string().min(1).max(200),
      artifact_id: z.string().max(100).optional(),
      note: z.string().max(1000).optional(),
    }),
    run: (async (args: { path: string; title: string; artifact_id?: string; note?: string }) => {
      const result = await publishArtifact(hub, agent.id, { path: args.path, title: args.title, artifactId: args.artifact_id?.trim() || undefined, note: args.note, audienceId: hub.turnAudience(agent.id) });
      if (!result.ok) return text(`not published: ${result.error}`, true);
      await hub.addMessage(agent.id, "agent", "", null, undefined, undefined, undefined, undefined, result.card, undefined, hub.turnAudience(agent.id));
      return text(
        `published "${result.card.title}" as artifact_id ${result.artifactId}, version ${result.version}. Your owner sees it beside the chat, so do not paste its contents. To change it, edit the file and call publish_artifact again with artifact_id ${result.artifactId}.`,
      );
    }) as Builtin["run"],
  });

  if (enabled.notify_owner) {
    builtins.push({
      name: "notify_owner",
      description:
        "Send a short message to your owner. It always lands in your chat with them in the panel and, when Slack is on, as a Slack direct message to them. This is how you reach your owner: you never need their Slack name, email or ID. Does not wait for an answer.",
      schema: z.object({ text: z.string().min(1).max(2000) }),
      run: (async (args: { text: string }) => {
        const label = outsider() ? await outsiderLabel(agent.id) : null;
        if (label && !outsiderLimiter.allow(`outsider:${agent.id}`, 1 / 60, 3)) return text(brainText.outsiderBusy, true);
        const result = await hub.notifyOwner(agent.id, label ? `${label}${args.text}` : args.text);
        if (result.slack) return text({ delivered: true, slack: true });
        return text({ delivered: true, slack: false, note: ownerSlackNote(result.error) });
      }) as Builtin["run"],
    });
  }

  builtins.push(...(teamTools(hub, agent) as Builtin[]));
  builtins.push(...(taskTools(hub, agent) as Builtin[]));
  builtins.push(...(followupTools(hub, agent, { outsider: () => outsider() || guestTurn(agent.id), untrusted: () => turnUntrusted(agent.id), runId: () => turnRunId(agent.id, runningRunId) }) as Builtin[]));

  const guard = async (input: GuardInput) => {
    const run = input.toOwner ? null : await turnRun(agent.id);
    const handedOff = run?.trigger === "handoff";
    const extra = input.extra as Extra;
    const tool = extra.call ? actionToolName(extra.call.name) : null;
    return guardOutward(hub, agent, input.target, input.summary, input.fields, input.args, input.ask || handedOff, waitOutcome, extra, {
      runId: run?.id ?? null,
      forced: handedOff,
      ...(tool ? { grant: { gatekeeperTool: tool } } : {}),
    });
  };

  if (await slackEnabled()) {
    builtins.push(
      ...(slackTools({
        agent: { id: agent.id, name: agent.name, iconUrl: agentIdentity(agent).iconUrl },
        owner: () => slackUserIdFor({ id: agent.ownerId, email: ownerEmail }),
        mode: slackMode(agent.tools),
        api: slackApi(),
        guard,
        fetchFile: (path) => hub.requestFile(agent.id, path),
      }) as Builtin[]),
    );
  }

  const { upstreams, ceilings, permissionOf, toolsOf, findTool } = await connectorAccess(agent, ownerEmail, restricted);
  const splitProxied = (name: string) => {
    const [slug, ...rest] = name.split(PROXY_SEPARATOR);
    return { upstream: upstreams.find((u) => u.slug === slug), toolName: rest.join(PROXY_SEPARATOR) };
  };
  const actionForced = async (tool: string) => {
    const handedOff = (await turnRun(agent.id))?.trigger === "handoff";
    if (builtins.some((b) => b.name === tool)) return handedOff;
    const { upstream, toolName } = splitProxied(tool);
    const found = upstream && toolName ? await findTool(upstream, toolName) : undefined;
    if (!upstream || !found) return true;
    return !canAlwaysAllow(ceilings.get(upstream.id) ?? {}, toolName, found.annotations) || (handedOff && !isReadOnly(found.annotations));
  };
  const actionAllowed = async (tool: string) => {
    if (tool === "request_approval" || tool === "wait_for_approval" || tool === "run_approvals") return false;
    if (builtins.some((b) => b.name === tool)) return true;
    const { upstream, toolName } = splitProxied(tool);
    const found = upstream && toolName ? await findTool(upstream, toolName) : undefined;
    return Boolean(upstream && found && permissionOf(upstream, found) !== "never");
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (outsider()) return { tools: builtins.filter((b) => OUTSIDER_TOOLS.has(b.name)).map((b) => ({ name: b.name, description: b.description, inputSchema: jsonSchemaOf(b.schema) })) };
    const proxied = await Promise.all(
      upstreams.map(async (upstream) => {
        try {
          const tools = await toolsOf(upstream);
          await recordFirstHints(agent, upstream.id, tools).catch((error) => console.error(JSON.stringify({ event: "tool_hints_record_error", server: upstream.slug, error: String(error) })));
          return tools
            .map((tool) => ({ tool, permission: permissionOf(upstream, tool) }))
            .filter(({ permission }) => permission !== "never")
            .map(({ tool, permission }) => ({
              name: `${upstream.slug}${PROXY_SEPARATOR}${tool.name}`,
              description: `[${upstream.name}] ${tool.description ?? ""}${permission === "ask" ? " (the owner approves every call; it may take a while)" : ""}`.trim(),
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
    const cancel = new AbortController();
    const key = cancelKey(agent.id, (extra as { requestId?: unknown }).requestId);
    cancels.set(key, cancel);
    const callExtra = { ...(extra as unknown as Extra), signal: AbortSignal.any([extra.signal, cancel.signal]), call: { name } };
    const run = builtin ? null : await turnRun(agent.id);
    const runId = run?.id ?? null;
    try {
      let result: ToolResult;
      if (outsider() && !OUTSIDER_TOOLS.has(name)) {
        result = text(brainText.outsiderTool, true);
      } else if (builtin) {
        const parsed = builtin.schema.safeParse(args);
        result = parsed.success ? await builtin.run(parsed.data as never, callExtra) : text(parsed.error.message, true);
      } else {
        const { upstream, toolName } = splitProxied(name);
        if (!upstream || !toolName) {
          result = text(`unknown tool ${name}`, true);
        } else {
          const tool = await findTool(upstream, toolName);
          const ceiling = ceilings.get(upstream.id) ?? {};
          result = tool
            ? await proxyCall(hub, agent, upstream, tool, args, permissionOf(upstream, tool), ceiling, run, waitOutcome, callExtra)
            : { ...text(`not called: ${upstream.name} does not list ${toolName}`, true), verdict: "blocked" };
        }
      }
      const { verdict, ...shown } = result;
      await logCall(agent.id, name, args, shown.content[0]?.text?.slice(0, 4000), !shown.isError, verdict, runId);
      return shown;
    } catch (error) {
      console.error(JSON.stringify({ at: new Date().toISOString(), event: "gatekeeper_call_error", agentId: agent.id, tool: name, error: errorLine(error) }));
      await logCall(agent.id, name, args, String(error), false, undefined, runId);
      return text(String(error), true);
    } finally {
      if (cancels.get(key) === cancel) cancels.delete(key);
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
  approval: { runId?: string | null; grant?: ApprovalGrant; forced?: boolean; panelSummary?: boolean } = {},
): Promise<GuardResult & { asked?: boolean; pending?: boolean; approvalId?: string; skipped?: "mode" | "listed" }> {
  fields = withoutForeignReviewer(fields);
  const forced = Boolean(approval.forced);
  const violation = findViolation(agent.rules ?? [], argsSubject(args));
  if (violation) {
    const rule = describeRule(violation.rule);
    await reportRuleBlock(hub, agent.id, rule, violation.reason).catch(() => {});
    return { ok: false, text: `not done: blocked by your owner's rule "${rule}": ${violation.reason}. Do not try another way; stop and tell your owner.` };
  }
  const runId = approval.runId ?? null;
  const closed = await closedRunText(hub, agent.id, runId);
  if (closed) return { ok: false, text: closed.replace(/^not asked:/, "not done:") };
  const tool = extra.call ? actionToolName(extra.call.name) : null;
  const { policy, mode } = ask && !approval.forced ? await approvalMode(hub, agent) : { policy: null, mode: "always" as const };
  const skipped = !ask || !policy ? undefined : mode === "off" ? ("mode" as const) : listCoversActions(mode) && tool && toolListed(tool, policy.allow) ? ("listed" as const) : undefined;
  if (!ask || skipped) {
    const asked = tool ? await unapprovedAsk(agent.id, tool) : null;
    if (asked) return { ok: false, text: brainText.askedNotApproved(asked.status, asked.id) };
    return skipped ? { ok: true, skipped } : { ok: true };
  }
  if (extra.call && runId && (await hub.useActionApproval(agent.id, runId, actionHash(extra.call.name, args), ACTION_APPROVAL_MAX_AGE_MS, forced))) return { ok: true, asked: true };
  const hash = payloadHash(target, args);
  const earlier = runId ? await hub.reusableApproval(agent.id, runId, hash, forced) : null;
  if (earlier?.status === "denied") return { ok: false, asked: true, text: brainText.alreadyDenied(earlier.id) };
  const grant = approval.grant && "gatekeeperTool" in approval.grant && (approval.forced || !listCoversActions(mode)) ? undefined : approval.grant;
  const reviewed = earlier || forced || mode !== "auto" ? null : await autoReview(hub, agent, { summary, fields, runId: runId ?? undefined, ...(approval.panelSummary ? { source: "panel" as const } : {}) }, { lifetimeSeconds: APPROVAL_LIFETIME_SECONDS, payloadHash: hash, grant });
  const id = earlier?.id ?? (reviewed?.kind === "approved" ? reviewed.id : await hub.createApproval(agent.id, { summary, fields: reviewed?.fields ?? fields, runId: runId ?? undefined }, "mcp", APPROVAL_LIFETIME_SECONDS, hash, grant, reviewed?.review));
  const outcome = await waitOutcome(id, extra);
  if (extra.signal?.aborted) return { ok: false, asked: true, text: "not done: the call was cut off before it could go through" };
  if (outcome.kind === "pending") return { ok: false, asked: true, pending: true, text: runId ? brainText.callPending(id) : brainText.callPendingOutsideRun(id) };
  if (outcome.kind !== "decided" || !outcome.approved) return { ok: false, asked: true, text: `not done: the owner ${outcomeText(id, outcome).content[0].text}` };
  const approvedHash = await hub.approvalPayloadHash(id, agent.id);
  if (!approvedHash || approvedHash !== hash) return { ok: false, asked: true, text: "not done: the arguments differ from what the owner approved" };
  if (extra.signal?.aborted) return { ok: false, asked: true, text: "not done: the call was cut off before it could go through" };
  if (!(await hub.consumeApproval(id, agent.id))) return { ok: false, asked: true, text: `not done: that approval was already used by the same call [requestId: ${id}]` };
  return { ok: true, asked: true, approvalId: id };
}

export function connectorApprovalFields(connector: string, tool: Pick<UpstreamTool, "name" | "description" | "annotations">, args: Record<string, unknown>) {
  const t = messages.toolAccess;
  const shown = approvalFields(args);
  if ("error" in shown) return shown;
  const about = oneLine(tool.description);
  const fields = [
    { label: t.fieldConnector, value: connector },
    { label: t.fieldAction, value: tool.name },
    ...(about ? [{ label: t.fieldWhat, value: about }] : []),
    ...(isDestructive(tool.annotations) ? [{ label: t.fieldWarning, value: t.destructiveWarning }] : []),
    ...shown.fields,
  ];
  if (fields.length > MAX_APPROVAL_FIELDS) return { error: `at most ${MAX_APPROVAL_FIELDS - (fields.length - shown.fields.length)} arguments` } as const;
  return { fields } as const;
}

async function proxyCall(
  hub: Hub,
  agent: AgentRow,
  upstream: UpstreamServer,
  tool: Pick<UpstreamTool, "name" | "description" | "annotations">,
  args: Record<string, unknown>,
  permission: ToolPermission,
  ceiling: ConnectorCeiling,
  run: { id: string; trigger: string } | null,
  waitOutcome: (id: string, extra: Extra) => Promise<Outcome>,
  extra: Extra,
): Promise<ToolResult> {
  const toolName = tool.name;
  if (permission === "never") {
    return { ...text(`not called: your owner turned off ${upstream.name}'s ${toolName} for you. Do not try another way; tell your owner if you need it.`, true), verdict: "blocked" };
  }
  const handedOffWrite = run?.trigger === "handoff" && !isReadOnly(tool.annotations);
  const needsApproval = permission === "ask" || handedOffWrite;
  if (!needsApproval && isSlackProfile(upstream.url) && !isReadOnly(tool.annotations) && !slackProfileLimiter.allow(`slack-profile:${agent.ownerId}:write`, SLACK_LIMITS.writesPerHour / 3600, SLACK_LIMITS.writeBurst)) {
    return { ...text(`not called: you already did ${SLACK_LIMITS.writeBurst} Slack actions as your owner in a short time; wait a few minutes, or tell your owner if the work needs more.`, true), verdict: "blocked" };
  }
  const shown = needsApproval ? connectorApprovalFields(upstream.name, tool, args) : { fields: [] };
  if ("error" in shown) {
    return { ...text(`not called: calls that need approval need ${shown.error}, so the owner sees exactly what will run`, true), verdict: "denied" };
  }
  const adminAllows = canAlwaysAllow(ceiling, toolName, tool.annotations);
  const grant = adminAllows ? { serverId: upstream.id, tool: toolName } : undefined;
  const summary = messages.toolAccess.approvalSummary(upstream.name, toolName);
  const allowed = await guardOutward(hub, agent, `${upstream.id}:${toolName}`, summary, [...shown.fields], args, needsApproval, waitOutcome, extra, { runId: run?.id ?? null, grant, forced: !adminAllows || handedOffWrite, panelSummary: true });
  if (!allowed.ok) return { ...text(allowed.text.replace(/^not done:/, "not called:"), true), verdict: allowed.pending ? undefined : allowed.asked ? "denied" : "blocked" };
  if (extra.signal?.aborted) {
    if (allowed.approvalId) await hub.releaseApproval(allowed.approvalId, agent.id);
    return text("not called: the call was cut off before it could go through", true);
  }
  const result = await callUpstreamTool(upstream, toolName, args, agent.ownerId);
  const content = Array.isArray(result.content) ? result.content : [];
  const parts = content.map((part: { type: string; text?: string }) => (part.type === "text" ? part.text ?? "" : JSON.stringify(part)));
  return { ...text(parts.join("\n") || JSON.stringify(result), Boolean(result.isError)), verdict: allowed.asked ? "approved" : "allowed" };
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

export async function handleGatekeeper(hub: Hub, req: IncomingMessage, res: ServerResponse, restricted = false) {
  const agent = await authenticateComputer(req.headers.authorization);
  if (!agent) return reject(res, 401, "unauthorized");
  if (req.method !== "POST") return reject(res, 405, "method not allowed");
  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    return reject(res, 400, "invalid json");
  }
  cancelRequests(agent.id, body);
  const server = await buildServer(hub, agent, agent.ownerEmail, restricted);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close().catch(() => undefined);
    server.close().catch(() => undefined);
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

type ComputerAgent = NonNullable<Awaited<ReturnType<typeof authenticateComputer>>>;

const GIT_READ_TOOL = "get_file_contents";
const GIT_PUSH_TOOL = "push_files";

async function githubConnection(agent: ComputerAgent) {
  const access = await connectorAccess(agent, agent.ownerEmail);
  const upstream = access.upstreams.find((server) => usesGithubApp(server));
  if (!upstream) return null;
  const [read, push] = await Promise.all([access.findTool(upstream, GIT_READ_TOOL), access.findTool(upstream, GIT_PUSH_TOOL)]);
  return { upstream, read: read ? access.permissionOf(upstream, read) : "never", push: push ? access.permissionOf(upstream, push) : "never" } as const;
}

export async function githubGitAccess(agent: ComputerAgent): Promise<GitAccess> {
  if (outsiderTurn(agent.id)) return { connected: true, read: false, push: "never", refusal: brainText.outsiderTool };
  const github = await githubConnection(agent);
  if (!github) return { connected: false, read: false, push: "never" };
  return { connected: true, read: github.read !== "never", push: github.push };
}

export async function gateGitPush(hub: Hub, agent: ComputerAgent, push: GitPush, onAsk: () => void, signal: AbortSignal): Promise<PushGate> {
  if (outsiderTurn(agent.id)) return { ok: false, reason: brainText.outsiderTool };
  const github = await githubConnection(agent);
  if (!github || github.push === "never") return { ok: false, reason: "your owner turned off pushing to GitHub for you" };
  const run = await turnRun(agent.id);
  const runId = run?.id ?? null;
  const t = messages.toolAccess;
  const { ask, fields } = gitPushApproval(push, github.push, run?.trigger === "handoff", github.upstream.name, {
    connector: t.fieldConnector,
    action: t.fieldAction,
    repository: t.fieldRepository,
    branches: t.fieldBranches,
    warning: t.fieldWarning,
    defaultBranchWarning: t.defaultBranchWarning,
  });
  const args = { repository: push.repository, refs: push.refs };
  const name = `${github.upstream.slug}${PROXY_SEPARATOR}git_push`;
  if (ask) onAsk();
  const extra: Extra = { signal, sendNotification: async () => undefined };
  const allowed = await guardOutward(hub, agent, `${github.upstream.id}:git_push`, t.approvalSummary(github.upstream.name, "git push"), fields, args, ask, outcomeWaiter(hub, agent.id), extra, { runId, forced: true });
  if (!allowed.ok) {
    await logCall(agent.id, name, args, allowed.text, false, allowed.asked ? "denied" : "blocked", runId);
    return { ok: false, reason: allowed.text.replace(/^not done: /, "") };
  }
  return { ok: true, finish: (ok, note) => logCall(agent.id, name, args, note, ok, ask ? "approved" : "allowed", runId) };
}
