import type { IncomingMessage, ServerResponse } from "node:http";
import { and, eq, inArray } from "drizzle-orm";
import { agentAccess, canAnswer } from "@/lib/access";
import { getDb, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { messages as copy } from "@/lib/messages";
import type { Hub } from "./hub";
import { RateLimiter } from "./rate-limit";
import { pickAgent, stripMentions, verifySlackSignature } from "./slack-app";
import { agentIdentity, escapeSlack, slackConfig, slackUserEmail } from "./slack";
import { linkedPanelUser, slackLinkUrl } from "./slack-link";
import { agentForThread, postAgentText, setThread, setThreadStatus, setThreadTitle, startAssistantThread } from "./slack-threads";
import { ownerAudience } from "./teams-store";

const MAX_BODY_BYTES = 256 * 1024;
const limiter = new RateLimiter();
const seenEvents = new Map<string, number>();

type SlackEvent = {
  type: string;
  user?: string;
  text?: string;
  channel?: string;
  channel_type?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
  subtype?: string;
  assistant_thread?: { user_id?: string; channel_id?: string; thread_ts?: string };
};

function log(event: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
}

function reply(res: ServerResponse, status: number, body?: unknown) {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function header(req: IncomingMessage, name: string) {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function firstSeen(eventId: string | undefined) {
  if (!eventId) return true;
  const now = Date.now();
  for (const [id, at] of seenEvents) if (now - at > 60 * 60 * 1000) seenEvents.delete(id);
  if (seenEvents.has(eventId)) return false;
  seenEvents.set(eventId, now);
  return true;
}

async function panelUser(slackUserId: string | undefined) {
  if (!slackUserId) return null;
  const linkedId = await linkedPanelUser(slackUserId);
  const email = linkedId ? null : await slackUserEmail(slackUserId);
  if (!linkedId && !email) return null;
  const [user] = await getDb()
    .select()
    .from(schema.user)
    .where(linkedId ? eq(schema.user.id, linkedId) : eq(schema.user.email, email as string));
  return user && user.status === "approved" ? user : null;
}

function unknownUserMarkdown(slackUserId: string) {
  return copy.slackApp.unknownUserLink(env.publicUrl, `[${copy.slackApp.connectLabel}](${slackLinkUrl(slackUserId)})`);
}

function unknownUserMrkdwn(slackUserId: string) {
  return copy.slackApp.unknownUserLink(env.publicUrl, `<${slackLinkUrl(slackUserId)}|${copy.slackApp.connectLabel}>`);
}

export async function rememberSlackReply(agentId: string, channel: string, threadTs?: string) {
  await setThread(agentId, { channel, threadTs, assistant: channel.startsWith("D") && Boolean(threadTs) });
}

export async function slackGiveUp(agentId: string, channel: string, threadTs?: string) {
  const [agent] = await getDb().select({ id: schema.agents.id, name: schema.agents.name }).from(schema.agents).where(eq(schema.agents.id, agentId));
  if (!agent) return;
  await postAgentText({ channel, threadTs, text: copy.slackApp.gaveUp, as: agentIdentity(agent) });
}

async function onMessage(hub: Hub, event: SlackEvent, teamId?: string) {
  const ignored = event.bot_id ? "bot" : event.subtype ? `subtype:${event.subtype}` : !event.user || !event.channel ? "incomplete" : null;
  if (ignored || !event.user || !event.channel) {
    if (event.user && limiter.allow("slack-ignored-log", 0.2, 5)) log("slack_event_ignored", { reason: ignored, type: event.type, channelType: event.channel_type });
    return;
  }
  const isDm = event.channel_type === "im";
  if (event.type === "message" && !isDm) return;
  const threadTs = isDm ? event.thread_ts : event.thread_ts ?? event.ts;
  const answer = (text: string, as?: { id: string; name: string }) =>
    postAgentText({ channel: event.channel as string, threadTs, text, as: as ? agentIdentity(as) : undefined });
  if (!limiter.allow(`slack-user:${event.user}`, 0.5, 10)) return;
  const user = await panelUser(event.user);
  if (!user) {
    log("slack_unknown_user", { dm: isDm });
    await answer(isDm ? unknownUserMarkdown(event.user) : copy.slackApp.unknownUser(env.publicUrl));
    return;
  }
  const agents = await getDb().select({ id: schema.agents.id, name: schema.agents.name }).from(schema.agents).where(eq(schema.agents.ownerId, user.id));
  const clean = stripMentions(event.text ?? "");
  const threadAgentId = await agentForThread(event.channel, threadTs);
  const threadAgent = agents.find((a) => a.id === threadAgentId) ?? null;
  const picked = pickAgent(clean, agents);
  const namedOther = picked.agent && picked.agent.id !== threadAgent?.id && picked.text !== clean;
  const route = threadAgent && !namedOther ? { agent: threadAgent, text: clean } : picked;
  if (!route.agent) {
    await answer("reason" in route && route.reason === "none" ? copy.slackApp.noAgents(env.publicUrl) : copy.slackApp.whichAgent(agents.map((a) => a.name)));
    return;
  }
  const agent = route.agent;
  const text = route.text.slice(0, 4000);
  if (!text) {
    await answer(copy.slackApp.sayWhat, agent);
    return;
  }
  const assistant = isDm && Boolean(event.thread_ts);
  if (assistant && threadTs && !threadAgentId) await setThreadTitle(event.channel, threadTs, text).catch((error) => log("slack_title_error", { error: String(error) }));
  const audience = await ownerAudience(agent.id);
  const messageId = await hub.addMessage(agent.id, "user", text, null, user.id, "slack", undefined, undefined, undefined, undefined, audience);
  await setThread(agent.id, { channel: event.channel, threadTs, assistant, slackUser: event.user, slackTeam: teamId });
  log("slack_message_routed", { agentId: agent.id, dm: isDm, assistant });
  const repeated = await hub.proposals.repeatOf(agent.id, user.id, text, messageId).catch((error) => (log("repeat_check_error", { error: String(error) }), null));
  const result = await hub.deliver(
    agent.id,
    { type: "chat", text, from: user.name, ...(audience ? { askedBy: audience } : {}), ...(repeated ? { repeated: { times: repeated.times, since: repeated.since.getTime() } } : {}) },
    { source: "slack", slack: { channel: event.channel, threadTs } },
  );
  if (result.status === "queued" && result.starting) await answer(copy.slackApp.starting, agent);
  else await setThreadStatus(agent.id, copy.slackApp.statusThinking).catch((error) => log("slack_status_error", { error: String(error) }));
}

async function onAssistantThreadStarted(event: SlackEvent) {
  const thread = event.assistant_thread;
  if (!thread?.channel_id || !thread.thread_ts) return;
  const user = await panelUser(thread.user_id);
  if (!user) {
    const text = thread.user_id ? unknownUserMarkdown(thread.user_id) : copy.slackApp.unknownUser(env.publicUrl);
    await postAgentText({ channel: thread.channel_id, threadTs: thread.thread_ts, text });
    return;
  }
  const agents = await getDb().select({ name: schema.agents.name }).from(schema.agents).where(eq(schema.agents.ownerId, user.id));
  await startAssistantThread({ channel: thread.channel_id, threadTs: thread.thread_ts, agentNames: agents.map((a) => a.name) });
  log("slack_assistant_thread_started");
}

async function handleEvents(hub: Hub, res: ServerResponse, body: string) {
  let payload: { type?: string; challenge?: string; event_id?: string; team_id?: string; event?: SlackEvent };
  try {
    payload = JSON.parse(body);
  } catch {
    return reply(res, 400);
  }
  if (payload.type === "url_verification") {
    log("slack_url_verified");
    return reply(res, 200, { challenge: String(payload.challenge ?? "") });
  }
  reply(res, 200);
  if (payload.type !== "event_callback" || !payload.event || !firstSeen(payload.event_id)) return;
  const event = payload.event;
  if (limiter.allow("slack-event-log", 1, 20)) log("slack_event_received", { type: event.type, channelType: event.channel_type });
  if (event.type === "app_mention" || event.type === "message") {
    await onMessage(hub, event, payload.team_id).catch((error) => log("slack_event_error", { error: String(error) }));
  } else if (event.type === "assistant_thread_started") {
    await onAssistantThreadStarted(event).catch((error) => log("slack_event_error", { error: String(error) }));
  } else if (event.type === "assistant_thread_context_changed") {
    log("slack_assistant_context_changed");
  }
}

async function handleInteractive(hub: Hub, res: ServerResponse, body: string) {
  let payload: { type?: string; user?: { id?: string }; actions?: { action_id?: string; value?: string }[]; response_url?: string };
  try {
    payload = JSON.parse(new URLSearchParams(body).get("payload") ?? "");
  } catch {
    return reply(res, 400);
  }
  reply(res, 200);
  const action = payload.actions?.[0];
  if (payload.type !== "block_actions" || !action) return;
  const respond = (text: string, replace: boolean) =>
    payload.response_url?.startsWith("https://hooks.slack.com/")
      ? fetch(payload.response_url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(replace ? { replace_original: true, text } : { response_type: "ephemeral", replace_original: false, text }),
        }).catch((error) => log("slack_respond_error", { error: String(error) }))
      : Promise.resolve();
  if (action.action_id === "proposal_save" || action.action_id === "proposal_dismiss") return answerProposal(hub, payload.user?.id, String(action.value ?? ""), action.action_id === "proposal_save", respond);
  if (!["approve", "approve_always", "deny"].includes(action.action_id ?? "")) return;
  const approvalId = String(action.value ?? "");
  const user = await panelUser(payload.user?.id);
  const [approval] = approvalId
    ? await getDb().select({ id: schema.approvals.id, agentId: schema.approvals.agentId, summary: schema.approvals.summary, askedBy: schema.approvals.askedBy, slackMessages: schema.approvals.slackMessages }).from(schema.approvals).where(eq(schema.approvals.id, approvalId))
    : [];
  if (!user || !approval || !canAnswer(await agentAccess(user.id, approval.agentId), approval.askedBy, user.id)) {
    log("slack_approval_refused", { approvalId, known: Boolean(user) });
    await respond(copy.slackApp.cannotAnswer, false);
    return;
  }
  const approved = action.action_id !== "deny";
  const ok = await hub.answerApproval(approval.id, approved, undefined, user.id, action.action_id === "approve_always", "slack");
  log("slack_approval_answered", { approvalId, approved, ok });
  if (approval.slackMessages?.length) return;
  const status = ok ? null : await hub.approvalStatus(approval.id);
  const summary = escapeSlack(approval.summary);
  await respond(ok ? copy.slackApp.answered(summary, approved, escapeSlack(user.name)) : status === "cancelled" ? copy.slackApp.stoppedBeforeAnswer(summary) : copy.slackApp.alreadyAnswered(summary), true);
}

async function answerProposal(hub: Hub, slackUserId: string | undefined, proposalId: string, save: boolean, respond: (text: string, replace: boolean) => Promise<unknown>) {
  const user = await panelUser(slackUserId);
  const [proposal] = proposalId
    ? await getDb()
        .select({ id: schema.taskProposals.id, recipe: schema.taskProposals.recipe, ownerId: schema.agents.ownerId })
        .from(schema.taskProposals)
        .innerJoin(schema.agents, eq(schema.agents.id, schema.taskProposals.agentId))
        .where(eq(schema.taskProposals.id, proposalId))
    : [];
  if (!user || !proposal || proposal.ownerId !== user.id) {
    log("slack_proposal_refused", { proposalId, known: Boolean(user) });
    await respond(copy.proposals.cannotAnswer, false);
    return;
  }
  const answered = await hub.proposals.answer(proposal.id, save, user.id).catch((error) => {
    log("slack_proposal_error", { proposalId, error: String(error) });
    return undefined;
  });
  log("slack_proposal_answered", { proposalId, save, ok: Boolean(answered) });
  if (answered === undefined) await respond(copy.proposals.failed, false);
  else if (answered === null) await respond(copy.proposals.slackAlready(escapeSlack(proposal.recipe.title)), false);
}

async function handleCommand(res: ServerResponse, body: string) {
  const form = new URLSearchParams(body);
  const slackUserId = form.get("user_id") ?? undefined;
  const user = await panelUser(slackUserId);
  if (!user) return reply(res, 200, { response_type: "ephemeral", text: slackUserId ? unknownUserMrkdwn(slackUserId) : copy.slackApp.unknownUser(env.publicUrl) });
  const db = getDb();
  const agents = await db.select({ id: schema.agents.id, name: schema.agents.name, state: schema.agents.state }).from(schema.agents).where(eq(schema.agents.ownerId, user.id));
  const pending = agents.length
    ? await db
        .select({ id: schema.approvals.id })
        .from(schema.approvals)
        .where(and(inArray(schema.approvals.agentId, agents.map((a) => a.id)), eq(schema.approvals.status, "pending")))
    : [];
  const lines = agents.map((a) => `• *${escapeSlack(a.name)}*: ${copy.slackApp.state[a.state] ?? a.state}`);
  const text = [copy.slackApp.statusTitle(pending.length, `${env.publicUrl}/waiting`), ...lines, "", copy.slackApp.howToTalk].join("\n");
  reply(res, 200, { response_type: "ephemeral", text });
}

export function isSlackRoute(pathname: string) {
  return pathname === "/api/slack/events" || pathname === "/api/slack/interactivity" || pathname === "/api/slack/interactive" || pathname === "/api/slack/commands";
}

export async function handleSlack(hub: Hub, req: IncomingMessage, res: ServerResponse, pathname: string) {
  if (req.method !== "POST") return reply(res, 405);
  const ip = header(req, "x-forwarded-for")?.split(",").at(-1)?.trim() ?? req.socket.remoteAddress ?? "unknown";
  if (!limiter.allow(`slack-ip:${ip}`, 20, 100)) return reply(res, 429);
  const config = await slackConfig();
  if (!config?.signingSecret) {
    log("slack_not_configured", { pathname });
    return reply(res, 404);
  }
  const body = await readBody(req);
  if (body === null) return reply(res, 413);
  if (!verifySlackSignature({ secret: config.signingSecret, timestamp: header(req, "x-slack-request-timestamp"), signature: header(req, "x-slack-signature"), body })) {
    log("slack_signature_refused", { pathname });
    return reply(res, 401);
  }
  if (pathname === "/api/slack/events") return handleEvents(hub, res, body);
  if (pathname === "/api/slack/interactivity" || pathname === "/api/slack/interactive") return handleInteractive(hub, res, body);
  return handleCommand(res, body);
}
