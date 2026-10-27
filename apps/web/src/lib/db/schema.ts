import { bigint, boolean, customType, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type { Look } from "../look";
import type { RoomRelay } from "../rooms";
import type { SeenHints, ToolPolicy, ToolVerdict } from "../tool-policy";
import type { ApprovalRequest, ArtifactKind, Attachment, Brain, AgentState, FileEntry, OwnerRule, Recipe, RecordedEvent, RunStep, Usage } from "@understudy/protocol";

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  status: text("status").notNull().default("pending"),
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
  admin: boolean("admin").notNull().default(false),
  adminGrantedAt: timestamp("admin_granted_at", { withTimezone: true }),
  source: text("source"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const twoFactor = pgTable(
  "two_factor",
  {
    id: text("id").primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    verified: boolean("verified").notNull().default(true),
    failedVerificationCount: integer("failed_verification_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
  },
  (t) => [index("two_factor_user_idx").on(t.userId)],
);

export type BrainStatus = { brain: Brain; loggedIn: boolean; account?: string };

export type AgentTools = {
  notifyOwner: boolean;
  slack: boolean;
  slackChannels: string[];
  slackMode?: "off" | "ask" | "free";
  slackProfileMode?: "ask" | "free";
  slackAnyone?: boolean;
  servers?: string[];
  askTools?: string[];
  toolPolicy?: ToolPolicy;
  toolHints?: SeenHints;
};

export const hosts = pgTable("hosts", {
  id: text("id").primaryKey(),
  trusted: boolean("trusted").notNull().default(false),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});

export type TeamRole = "admin" | "member";

export const teams = pgTable("teams", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  language: text("language"),
  createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const teamMembers = pgTable(
  "team_members",
  {
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").$type<TeamRole>().notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] }), index("team_members_user_idx").on(t.userId)],
);

export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    role: text("role").notNull().default(""),
    look: jsonb("look").$type<Look>().notNull(),
    brain: text("brain").$type<Brain>().notNull().default("claude"),
    tokenHash: text("token_hash").notNull(),
    state: text("state").$type<AgentState>().notNull().default("calm"),
    stateNote: text("state_note"),
    computerStatus: text("computer_status").notNull().default("pending"),
    computerMessage: text("computer_message"),
    brains: jsonb("brains").$type<BrainStatus[]>().notNull().default([]),
    credentials: jsonb("credentials").$type<CredentialInfo[]>().notNull().default([]),
    tools: jsonb("tools").$type<AgentTools>().notNull(),
    hostId: text("host_id"),
    model: text("model"),
    rules: jsonb("rules").$type<OwnerRule[]>().notNull().default([]),
    teamId: text("team_id").references(() => teams.id, { onDelete: "set null" }),
    teamOwned: boolean("team_owned").notNull().default(false),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agents_owner_idx").on(t.ownerId), index("agents_team_idx").on(t.teamId), uniqueIndex("agents_token_hash_idx").on(t.tokenHash)],
);

export type MessageRole = "agent" | "user" | "activity" | "system";

export type MessageArtifact = {
  artifactId: string;
  version: number;
  title: string;
  kind: ArtifactKind;
  name: string;
  pages: number;
  edit?: { quote?: string; page?: number };
};

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    runId: text("run_id"),
    role: text("role").$type<MessageRole>().notNull(),
    text: text("text").notNull(),
    authorId: text("author_id"),
    via: text("via"),
    sender: text("sender"),
    attachments: jsonb("attachments").$type<Attachment[]>(),
    artifact: jsonb("artifact").$type<MessageArtifact>(),
    proposalId: text("proposal_id"),
    audienceId: text("audience_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("messages_agent_idx").on(t.agentId, t.createdAt)],
);

export const recordings = pgTable(
  "recordings",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    status: text("status").$type<"recording" | "processing" | "done" | "failed">().notNull().default("recording"),
    source: text("source").$type<"computer" | "browser" | "chat">().notNull().default("computer"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
  },
  (t) => [index("recordings_agent_idx").on(t.agentId)],
);

const bytes = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const recordingAudio = pgTable(
  "recording_audio",
  {
    id: text("id").primaryKey(),
    recordingId: text("recording_id")
      .notNull()
      .references(() => recordings.id, { onDelete: "cascade" }),
    startedAt: bigint("started_at", { mode: "number" }).notNull(),
    mediaType: text("media_type").notNull(),
    audio: bytes("audio").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("recording_audio_recording_idx").on(t.recordingId)],
);

export const extensionTokens = pgTable(
  "extension_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    label: text("label").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("extension_tokens_user_idx").on(t.userId)],
);

export const extensionPairCodes = pgTable("extension_pair_codes", {
  codeHash: text("code_hash").primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const recordedEvents = pgTable(
  "recorded_events",
  {
    id: text("id").primaryKey(),
    recordingId: text("recording_id")
      .notNull()
      .references(() => recordings.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    event: jsonb("event").$type<RecordedEvent>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("recorded_events_recording_idx").on(t.recordingId, t.seq)],
);

export const recipes = pgTable(
  "recipes",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    recordingId: text("recording_id"),
    recipe: jsonb("recipe").$type<Recipe>().notNull(),
    cron: text("cron"),
    webhookSecret: text("webhook_secret"),
    webhookSecretHash: text("webhook_secret_hash"),
    timezone: text("timezone").notNull().default("UTC"),
    active: boolean("active").notNull().default(false),
    askAlways: boolean("ask_always").notNull().default(false),
    roomId: text("room_id").references(() => rooms.id, { onDelete: "set null" }),
    runsDone: integer("runs_done").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("recipes_agent_idx").on(t.agentId)],
);

export const recipeWatches = pgTable(
  "recipe_watches",
  {
    recipeId: text("recipe_id")
      .primaryKey()
      .references(() => recipes.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    part: text("part"),
    everyMinutes: integer("every_minutes").notNull().default(15),
    lastHash: text("last_hash"),
    lastText: text("last_text"),
    lastError: text("last_error"),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    changedAt: timestamp("changed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("recipe_watches_agent_idx").on(t.agentId)],
);

export type RunTrigger = "schedule" | "test" | "manual" | "webhook" | "email" | "handoff" | "watch" | "followup";
export type RunStatus = "running" | "ok" | "failed";

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    recipeId: text("recipe_id").references(() => recipes.id, { onDelete: "set null" }),
    trigger: text("trigger").$type<RunTrigger>().notNull(),
    status: text("status").$type<RunStatus>().notNull().default("running"),
    summary: text("summary"),
    input: text("input"),
    usage: jsonb("usage").$type<Usage>(),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("runs_agent_idx").on(t.agentId, t.startedAt),
    uniqueIndex("runs_recipe_schedule_idx").on(t.recipeId, t.scheduledFor),
  ],
);

export type ApprovalGrant = { serverId: string; tool: string };

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "cancelled";

export type ApprovalVia = "panel" | "slack" | "whatsapp" | "telegram";

export type SlackMessageRef = { channel: string; ts: string };

export const approvals = pgTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    runId: text("run_id"),
    stepId: text("step_id"),
    summary: text("summary").notNull(),
    fields: jsonb("fields").$type<ApprovalRequest["fields"]>().notNull().default([]),
    source: text("source").$type<"mcp" | "computer">().notNull(),
    requestId: text("request_id"),
    payloadHash: text("payload_hash"),
    status: text("status").$type<ApprovalStatus>().notNull().default("pending"),
    note: text("note"),
    answeredBy: text("answered_by"),
    askedBy: text("asked_by"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    usedAt: timestamp("used_at", { withTimezone: true }),
    grant: jsonb("tool_grant").$type<ApprovalGrant | null>(),
    answeredVia: text("answered_via").$type<ApprovalVia>(),
    slackMessages: jsonb("slack_messages").$type<SlackMessageRef[]>(),
  },
  (t) => [index("approvals_agent_idx").on(t.agentId, t.status)],
);

export const toolCalls = pgTable(
  "tool_calls",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    tool: text("tool").notNull(),
    args: jsonb("args").$type<unknown>(),
    result: jsonb("result").$type<unknown>(),
    ok: boolean("ok").notNull(),
    runId: text("run_id"),
    verdict: text("verdict").$type<ToolVerdict>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("tool_calls_agent_idx").on(t.agentId, t.createdAt), index("tool_calls_run_idx").on(t.runId)],
);

export const memoryFiles = pgTable(
  "memory_files",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    text: text("text").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.path] })],
);

export const mcpServers = pgTable("mcp_servers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  url: text("url").notNull(),
  headerName: text("header_name"),
  headerValue: text("header_value"),
  oauthClient: text("oauth_client"),
  askAll: boolean("ask_all").notNull().default(false),
  askTools: jsonb("ask_tools").$type<string[]>().notNull().default([]),
  allowedEmails: jsonb("allowed_emails").$type<string[] | null>(),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const mcpToolLimits = pgTable(
  "mcp_tool_limits",
  {
    serverId: text("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    tool: text("tool").notNull(),
    level: text("level").$type<"ask" | "never">().notNull(),
    updatedBy: text("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.serverId, t.tool] })],
);

export const mcpServerLogins = pgTable(
  "mcp_server_logins",
  {
    serverId: text("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    tokens: text("tokens"),
    state: text("state").unique(),
    verifier: text("verifier"),
    returnTo: text("return_to"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.serverId, t.userId] })],
);

export const runRecords = pgTable("run_records", {
  runId: text("run_id")
    .primaryKey()
    .references(() => runs.id, { onDelete: "cascade" }),
  steps: jsonb("steps").$type<RunStep[]>().notNull().default([]),
  unusual: jsonb("unusual").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentFiles = pgTable(
  "agent_files",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    size: integer("size").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.path] })],
);

export type CredentialInfo = { name: string; username: string; site?: string; kind?: "api_key"; sendAs?: "bearer" | "scheme" | "header" | "basic" | "query"; field?: string; tokenPath?: string };

export type MemberRole = "approver" | "viewer";

export const agentMembers = pgTable(
  "agent_members",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").$type<MemberRole>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.userId] }), index("agent_members_user_idx").on(t.userId)],
);

export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, string>>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("push_subscriptions_user_idx").on(t.userId)],
);

export const recipeInbound = pgTable("recipe_inbound", {
  recipeId: text("recipe_id")
    .primaryKey()
    .references(() => recipes.id, { onDelete: "cascade" }),
  localPart: text("local_part").notNull().unique(),
  allowedSenders: text("allowed_senders"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const templates = pgTable(
  "templates",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    recipe: jsonb("recipe").$type<Recipe>().notNull(),
    cron: text("cron"),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    uses: integer("uses").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("templates_created_idx").on(t.createdAt)],
);

export type AgentMessageKind = "message" | "handoff" | "stop" | "resume";

export const agentMessages = pgTable(
  "agent_messages",
  {
    id: text("id").primaryKey(),
    fromAgentId: text("from_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    toAgentId: text("to_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    kind: text("kind").$type<AgentMessageKind>().notNull(),
    text: text("text").notNull(),
    task: text("task"),
    runId: text("run_id"),
    depth: integer("depth").notNull().default(1),
    delivered: boolean("delivered").notNull().default(true),
    audienceId: text("audience_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agent_messages_to_idx").on(t.toAgentId, t.createdAt), index("agent_messages_pair_idx").on(t.fromAgentId, t.toAgentId, t.createdAt)],
);

export const inboundQueue = pgTable(
  "inbound_queue",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    message: jsonb("message").$type<Record<string, unknown>>().notNull(),
    source: text("source").notNull(),
    slackChannel: text("slack_channel"),
    slackThreadTs: text("slack_thread_ts"),
    channelThreadId: text("channel_thread_id"),
    runId: text("run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("inbound_queue_agent_idx").on(t.agentId, t.createdAt)],
);

export const slackThreads = pgTable(
  "slack_threads",
  {
    agentId: text("agent_id")
      .primaryKey()
      .references(() => agents.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    threadTs: text("thread_ts"),
    assistant: boolean("assistant").notNull().default(false),
    slackUser: text("slack_user"),
    slackTeam: text("slack_team"),
    progressTs: text("progress_ts"),
    progressRunId: text("progress_run_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("slack_threads_thread_idx").on(t.channel, t.threadTs)],
);

export const slackAskerThreads = pgTable(
  "slack_asker_threads",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    askedBy: text("asked_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    threadTs: text("thread_ts"),
    slackUser: text("slack_user").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("slack_asker_threads_thread_idx").on(t.channel, t.threadTs), index("slack_asker_threads_expires_idx").on(t.expiresAt)],
);

export type ChannelKind = "slack" | "telegram" | "teams" | "whatsapp" | "sms";

export type UnknownSenders = "hold" | "ignore";

export type HeldMessage = {
  subject: string;
  text: string;
  date: string | null;
  attachments: { filename: string; mimeType: string; base64: string; bytes: number }[];
  droppedAttachments: number;
};

export type PendingFile = Attachment;

export const agentChannels = pgTable(
  "agent_channels",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    kind: text("kind").$type<ChannelKind>().notNull(),
    address: text("address").notNull(),
    allowedSenders: text("allowed_senders"),
    unknownSenders: text("unknown_senders").$type<UnknownSenders>().notNull().default("hold"),
    secret: text("secret"),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("agent_channels_address_idx").on(t.kind, t.address), uniqueIndex("agent_channels_agent_kind_idx").on(t.agentId, t.kind)],
);

export const channelSecrets = pgTable(
  "channel_secrets",
  {
    channelId: text("channel_id")
      .notNull()
      .references(() => agentChannels.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    value: text("value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.channelId, t.name] })],
);

export const channelThreads = pgTable(
  "channel_threads",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => agentChannels.id, { onDelete: "cascade" }),
    peer: text("peer").notNull(),
    peerName: text("peer_name"),
    trusted: boolean("trusted").notNull().default(false),
    status: text("status").$type<"open" | "held">().notNull().default("open"),
    subject: text("subject").notNull().default(""),
    lastMessageId: text("last_message_id"),
    references: text("references").notNull().default(""),
    held: jsonb("held").$type<HeldMessage>(),
    pendingText: text("pending_text").notNull().default(""),
    pendingFiles: jsonb("pending_files").$type<PendingFile[]>().notNull().default([]),
    pendingSince: timestamp("pending_since", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("channel_threads_channel_idx").on(t.channelId, t.peer, t.updatedAt), index("channel_threads_pending_idx").on(t.pendingSince)],
);

export const channelRoutes = pgTable("channel_routes", {
  agentId: text("agent_id")
    .primaryKey()
    .references(() => agents.id, { onDelete: "cascade" }),
  threadId: text("thread_id")
    .notNull()
    .references(() => channelThreads.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const rooms = pgTable(
  "rooms",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    teamId: text("team_id").references(() => teams.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("rooms_owner_idx").on(t.ownerId, t.updatedAt), index("rooms_team_idx").on(t.teamId)],
);

export const roomPeople = pgTable(
  "room_people",
  {
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.roomId, t.userId] }), index("room_people_user_idx").on(t.userId)],
);

export const roomParticipants = pgTable(
  "room_participants",
  {
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    turnDepth: integer("turn_depth"),
    turnStartedAt: timestamp("turn_started_at", { withTimezone: true }),
    followUp: boolean("follow_up").notNull().default(false),
    askedBy: text("asked_by"),
    followUpAskedBy: text("follow_up_asked_by"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.roomId, t.agentId] }), index("room_participants_agent_idx").on(t.agentId)],
);

export type RoomAuthor = "owner" | "person" | "agent" | "system";

export const roomMessages = pgTable(
  "room_messages",
  {
    id: text("id").primaryKey(),
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    author: text("author").$type<RoomAuthor>().notNull(),
    agentId: text("agent_id").references(() => agents.id, { onDelete: "set null" }),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    text: text("text").notNull(),
    approvalId: text("approval_id"),
    runId: text("run_id"),
    relay: jsonb("relay").$type<RoomRelay>(),
    depth: integer("depth").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("room_messages_room_idx").on(t.roomId, t.createdAt), index("room_messages_agent_idx").on(t.agentId, t.createdAt)],
);

export const artifacts = pgTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    kind: text("kind").$type<ArtifactKind>().notNull(),
    latestVersion: integer("latest_version").notNull().default(1),
    audienceId: text("audience_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("artifacts_agent_idx").on(t.agentId, t.updatedAt)],
);

export const artifactVersions = pgTable(
  "artifact_versions",
  {
    id: text("id").primaryKey(),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    kind: text("kind").$type<ArtifactKind>().notNull(),
    note: text("note").notNull().default(""),
    name: text("name").notNull(),
    sourcePath: text("source_path"),
    size: bigint("size", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    pages: integer("pages").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("artifact_versions_number_idx").on(t.artifactId, t.version)],
);

export const artifactBlobs = pgTable("artifact_blobs", {
  key: text("key").primaryKey(),
  contentType: text("content_type").notNull(),
  data: bytes("data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const artifactLinks = pgTable(
  "artifact_links",
  {
    id: text("id").primaryKey(),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    tokenHash: text("token_hash").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("artifact_links_token_idx").on(t.tokenHash), index("artifact_links_artifact_idx").on(t.artifactId)],
);

export type ProposalOrigin = "repeated" | "multi_step";
export type ProposalStatus = "pending" | "saved" | "dismissed";

export const taskProposals = pgTable(
  "task_proposals",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    recipe: jsonb("recipe").$type<Recipe>().notNull(),
    cron: text("cron"),
    timezone: text("timezone").notNull().default("UTC"),
    reason: text("reason").notNull(),
    origin: text("origin").$type<ProposalOrigin>().notNull(),
    status: text("status").$type<ProposalStatus>().notNull().default("pending"),
    recipeId: text("recipe_id").references(() => recipes.id, { onDelete: "set null" }),
    slackChannel: text("slack_channel"),
    slackTs: text("slack_ts"),
    askedBy: text("asked_by"),
    answeredBy: text("answered_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
  },
  (t) => [index("task_proposals_agent_idx").on(t.agentId, t.status)],
);

export type FollowupStatus = "pending" | "fired" | "cancelled" | "stopped";

export const followups = pgTable(
  "followups",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    note: text("note").notNull(),
    recipeId: text("recipe_id").references(() => recipes.id, { onDelete: "set null" }),
    origin: text("origin"),
    chainId: text("chain_id").notNull(),
    emptyWakes: integer("empty_wakes").notNull().default(0),
    bookedInRunId: text("booked_in_run_id"),
    askedBy: text("asked_by"),
    status: text("status").$type<FollowupStatus>().notNull().default("pending"),
    runId: text("run_id"),
    cancelledBy: text("cancelled_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    firedAt: timestamp("fired_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [index("followups_agent_idx").on(t.agentId, t.status, t.dueAt), index("followups_due_idx").on(t.status, t.dueAt)],
);
