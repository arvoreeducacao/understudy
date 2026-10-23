import { randomBytes } from "node:crypto";
import type { ToolHints } from "@/lib/tool-policy";

export const GMAIL_MCP_HOST = "gmailmcp.googleapis.com";
export const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
export const GMAIL_ALWAYS_ASK = ["send_email"];

const MAX_PAGE = 25;
const MAX_RECIPIENTS = 50;
const MAX_BODY_CHARS = 20_000;
const MAX_THREAD_MESSAGES = 50;
const LIST_HEADERS = ["From", "To", "Subject", "Date"];
const READ_HEADERS = ["From", "To", "Cc", "Subject", "Date"];
const ID = /^[A-Za-z0-9_-]{1,200}$/;
const ADDRESS = /^[^\s@<>()[\],;:"\\]+@[^\s@<>()[\],;:"\\]+\.[^\s@<>()[\],;:"\\]+$/;

type Schema = { type: "object"; [key: string]: unknown };

export type GmailTool = { name: string; description: string; inputSchema: Schema; annotations: ToolHints };

export type GmailRequest = { method?: "GET" | "POST"; query?: Record<string, string | number | string[] | undefined>; body?: unknown };

export type GmailApi = (path: string, request?: GmailRequest) => Promise<unknown>;

export type GmailResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export class GmailError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

class InputError extends Error {}

export function answersGmailItself(server: { url: string }) {
  try {
    return new URL(server.url).host === GMAIL_MCP_HOST;
  } catch {
    return false;
  }
}

const readOnly: ToolHints = { readOnlyHint: true, destructiveHint: false };
const writes: ToolHints = { readOnlyHint: false, destructiveHint: false };

const format = {
  type: "string",
  enum: ["PLAIN_TEXT", "FULL_CONTENT", "MINIMAL", "METADATA_ONLY"],
  description: "PLAIN_TEXT (default) gives the text body; FULL_CONTENT adds the HTML body; MINIMAL gives headers and snippet; METADATA_ONLY gives headers and labels only.",
};

const paging = {
  query: { type: "string", description: "Gmail search, as typed in the Gmail search box, such as from:ana@example.com newer_than:7d." },
  pageSize: { type: "integer", minimum: 1, maximum: MAX_PAGE, description: `How many to return, 1 to ${MAX_PAGE} (default 10).` },
  pageToken: { type: "string", description: "nextPageToken from the previous page." },
};

const recipients = { type: "array", items: { type: "string" }, description: "Plain email addresses, such as ana@example.com." };

const message = {
  to: recipients,
  cc: recipients,
  bcc: recipients,
  subject: { type: "string" },
  body: { type: "string", description: "Plain-text body. Do not format it with Markdown." },
  htmlBody: { type: "string", description: "Optional HTML body. With both, body is the plain-text alternative." },
  replyToMessageId: { type: "string", description: "To reply in a thread, the id of the message being answered. Start the subject with Re:." },
};

export const GMAIL_TOOLS: GmailTool[] = [
  {
    name: "search_threads",
    description: "Lists email threads in the owner's Gmail, newest first, filtered by a Gmail search query. Each thread has its id, message count, snippet, viewUrl and up to 5 recent messages with sender, recipients, subject, date and labels. Use it to find thread ids before reading them.",
    inputSchema: { type: "object", properties: { ...paging } },
    annotations: readOnly,
  },
  {
    name: "get_thread",
    description: "Reads one email thread from the owner's Gmail with its messages (sender, recipients, subject, date, body and attachment names). Drafts are left out; use list_drafts for those.",
    inputSchema: { type: "object", properties: { threadId: { type: "string" }, messageFormat: format }, required: ["threadId"] },
    annotations: readOnly,
  },
  {
    name: "get_message",
    description: "Reads one email message from the owner's Gmail by id, with sender, recipients, subject, date, body and attachment names.",
    inputSchema: { type: "object", properties: { messageId: { type: "string" }, messageFormat: format }, required: ["messageId"] },
    annotations: readOnly,
  },
  {
    name: "list_drafts",
    description: "Lists drafts in the owner's Gmail, optionally filtered by a Gmail search query, with recipients, subject, snippet and viewUrl.",
    inputSchema: { type: "object", properties: { ...paging } },
    annotations: readOnly,
  },
  {
    name: "get_draft",
    description: "Reads one draft from the owner's Gmail by id, with its viewUrl for editing it in Gmail.",
    inputSchema: { type: "object", properties: { draftId: { type: "string" }, messageFormat: format }, required: ["draftId"] },
    annotations: readOnly,
  },
  {
    name: "list_labels",
    description: "Lists the labels in the owner's Gmail with their id, name and type.",
    inputSchema: { type: "object", properties: {} },
    annotations: readOnly,
  },
  {
    name: "create_draft",
    description: "Saves a new draft in the owner's Gmail for the owner to review and send. Returns the draft id and a viewUrl that opens it in Gmail.",
    inputSchema: { type: "object", properties: message, required: ["to", "subject"] },
    annotations: writes,
  },
  {
    name: "send_email",
    description: "Sends an email from the owner's Gmail right away. The owner approves every send and sees the exact recipients, subject and text first. When the owner should edit before sending, use create_draft instead.",
    inputSchema: { type: "object", properties: message, required: ["to", "subject"] },
    annotations: writes,
  },
];

function googleMessage(text: string) {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string; status?: string } | string; error_description?: string };
    if (typeof parsed.error === "string") return parsed.error_description ?? parsed.error;
    return parsed.error?.message ?? parsed.error?.status ?? text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

export function gmailApi(deps: {
  token: () => Promise<string | undefined> | string | undefined;
  renew: () => Promise<string>;
  fetch: (url: URL, init: RequestInit) => Promise<Response>;
  base?: string;
}): GmailApi {
  const base = (deps.base ?? GMAIL_API_BASE).replace(/\/$/, "");
  return async (path, request = {}) => {
    const url = new URL(`${base}/${path}`);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value === undefined || value === "") continue;
      for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item));
    }
    const send = (token: string) =>
      deps.fetch(url, {
        method: request.method ?? "GET",
        headers: { authorization: `Bearer ${token}`, ...(request.body === undefined ? {} : { "content-type": "application/json" }) },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    const stored = await deps.token();
    let res = await send(stored ?? (await deps.renew()));
    if (res.status === 401 && stored) res = await send(await deps.renew());
    const text = await res.text();
    if (!res.ok) throw new GmailError(res.status, googleMessage(text));
    return text ? (JSON.parse(text) as unknown) : {};
  };
}

function id(args: Record<string, unknown>, key: string) {
  const value = args[key];
  if (typeof value !== "string" || !ID.test(value.trim())) throw new InputError(`${key} must be a Gmail id`);
  return encodeURIComponent(value.trim());
}

function optionalText(args: Record<string, unknown>, key: string) {
  const value = args[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new InputError(`${key} must be text`);
  return value;
}

function pageSize(args: Record<string, unknown>) {
  const value = args.pageSize;
  if (value === undefined || value === null) return 10;
  const size = Number(value);
  if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE) throw new InputError(`pageSize must be 1 to ${MAX_PAGE}`);
  return size;
}

function formatOf(args: Record<string, unknown>) {
  const value = args.messageFormat ?? "PLAIN_TEXT";
  if (value !== "PLAIN_TEXT" && value !== "FULL_CONTENT" && value !== "MINIMAL" && value !== "METADATA_ONLY") throw new InputError("messageFormat is not one of the listed formats");
  return value;
}

function addressList(value: unknown, key: string) {
  if (value === undefined || value === null || value === "") return [];
  const items = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : null;
  if (!items || items.some((item) => typeof item !== "string")) throw new InputError(`${key} must be a list of email addresses`);
  const list = (items as string[]).map((item) => item.trim()).filter(Boolean);
  const bad = list.find((item) => !ADDRESS.test(item));
  if (bad) throw new InputError(`${key} has an address that is not a plain email address: ${bad.slice(0, 100)}`);
  return list;
}

function headerValue(value: string, key: string) {
  if (/[\r\n]/.test(value)) throw new InputError(`${key} cannot have line breaks`);
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function base64Lines(text: string) {
  return (Buffer.from(text, "utf8").toString("base64").match(/.{1,76}/g) ?? [""]).join("\r\n");
}

function textPart(type: "plain" | "html", text: string) {
  return [`Content-Type: text/${type}; charset="UTF-8"`, "Content-Transfer-Encoding: base64", "", base64Lines(text)].join("\r\n");
}

export type Outgoing = { to: string[]; cc: string[]; bcc: string[]; subject: string; body?: string; htmlBody?: string; inReplyTo?: string; references?: string };

export function mimeMessage(input: Outgoing, boundary = `understudy-${randomBytes(12).toString("hex")}`) {
  const headers = [
    `To: ${input.to.join(", ")}`,
    ...(input.cc.length ? [`Cc: ${input.cc.join(", ")}`] : []),
    ...(input.bcc.length ? [`Bcc: ${input.bcc.join(", ")}`] : []),
    `Subject: ${headerValue(input.subject, "subject")}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${headerValue(input.inReplyTo, "In-Reply-To")}`] : []),
    ...(input.references ? [`References: ${headerValue(input.references, "References")}`] : []),
    "MIME-Version: 1.0",
  ];
  if (input.body !== undefined && input.htmlBody !== undefined) {
    return [
      ...headers,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      textPart("plain", input.body),
      `--${boundary}`,
      textPart("html", input.htmlBody),
      `--${boundary}--`,
      "",
    ].join("\r\n");
  }
  return [...headers, input.htmlBody !== undefined ? textPart("html", input.htmlBody) : textPart("plain", input.body ?? "")].join("\r\n");
}

type Header = { name?: string; value?: string };
type Part = { mimeType?: string; filename?: string; headers?: Header[]; body?: { data?: string; size?: number; attachmentId?: string }; parts?: Part[] };
type GmailMessage = { id?: string; threadId?: string; labelIds?: string[]; snippet?: string; internalDate?: string; payload?: Part };

function header(headers: Header[] | undefined, name: string) {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value;
}

function headersOf(payload: Part | undefined, names: string[]) {
  return Object.fromEntries(names.map((name) => [name.toLowerCase(), header(payload?.headers, name)]).filter(([, value]) => value !== undefined));
}

function decoded(data: string | undefined) {
  return data ? Buffer.from(data, "base64url").toString("utf8") : "";
}

function walk(part: Part | undefined, found: { plain: string[]; html: string[]; attachments: { filename: string; mimeType?: string; size?: number }[] }) {
  if (!part) return found;
  if (part.filename) found.attachments.push({ filename: part.filename, mimeType: part.mimeType, size: part.body?.size });
  else if (part.mimeType === "text/plain") found.plain.push(decoded(part.body?.data));
  else if (part.mimeType === "text/html") found.html.push(decoded(part.body?.data));
  for (const child of part.parts ?? []) walk(child, found);
  return found;
}

function plainFromHtml(html: string) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function clipped(text: string) {
  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}\n[cut at ${MAX_BODY_CHARS} of ${text.length} characters]` : text;
}

function threadUrl(threadId: string | undefined) {
  return threadId ? `https://mail.google.com/mail/#all/${threadId}` : undefined;
}

function readMessage(message: GmailMessage, how: ReturnType<typeof formatOf>) {
  const base = {
    id: message.id,
    threadId: message.threadId,
    viewUrl: threadUrl(message.id),
    labelIds: message.labelIds,
    ...headersOf(message.payload, READ_HEADERS),
  };
  if (how === "METADATA_ONLY") return base;
  if (how === "MINIMAL") return { ...base, snippet: message.snippet };
  const parts = walk(message.payload, { plain: [], html: [], attachments: [] });
  const html = parts.html.join("\n");
  const body = parts.plain.join("\n").trim() || plainFromHtml(html);
  return {
    ...base,
    body: clipped(body),
    ...(how === "FULL_CONTENT" && html ? { htmlBody: clipped(html) } : {}),
    ...(parts.attachments.length ? { attachments: parts.attachments } : {}),
  };
}

function apiFormat(how: ReturnType<typeof formatOf>) {
  return how === "PLAIN_TEXT" || how === "FULL_CONTENT" ? "full" : "metadata";
}

async function outgoing(api: GmailApi, args: Record<string, unknown>) {
  const to = addressList(args.to, "to");
  const cc = addressList(args.cc, "cc");
  const bcc = addressList(args.bcc, "bcc");
  if (to.length === 0) throw new InputError("to needs at least one email address");
  if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) throw new InputError(`at most ${MAX_RECIPIENTS} recipients`);
  const subject = optionalText(args, "subject");
  if (!subject) throw new InputError("subject is required");
  const body = optionalText(args, "body");
  const htmlBody = optionalText(args, "htmlBody");
  if (body === undefined && htmlBody === undefined) throw new InputError("body or htmlBody is required");
  const reply = args.replyToMessageId === undefined || args.replyToMessageId === "" ? null : id(args, "replyToMessageId");
  let threadId: string | undefined;
  let inReplyTo: string | undefined;
  let references: string | undefined;
  if (reply) {
    const original = (await api(`messages/${reply}`, { query: { format: "metadata", metadataHeaders: ["Message-ID", "References"] } })) as GmailMessage;
    threadId = original.threadId;
    inReplyTo = header(original.payload?.headers, "Message-ID");
    references = [header(original.payload?.headers, "References"), inReplyTo].filter(Boolean).join(" ") || undefined;
  }
  const raw = Buffer.from(mimeMessage({ to, cc, bcc, subject, body, htmlBody, inReplyTo, references }), "utf8").toString("base64url");
  return { raw, ...(threadId ? { threadId } : {}) };
}

async function searchThreads(api: GmailApi, args: Record<string, unknown>) {
  const list = (await api("threads", { query: { q: optionalText(args, "query"), maxResults: pageSize(args), pageToken: optionalText(args, "pageToken") } })) as {
    threads?: { id: string; snippet?: string }[];
    nextPageToken?: string;
  };
  const threads = await Promise.all(
    (list.threads ?? []).map(async (thread) => {
      const full = (await api(`threads/${encodeURIComponent(thread.id)}`, { query: { format: "metadata", metadataHeaders: LIST_HEADERS } })) as { messages?: GmailMessage[] };
      const messages = full.messages ?? [];
      return {
        id: thread.id,
        viewUrl: threadUrl(thread.id),
        messageCount: messages.length,
        snippet: thread.snippet,
        messages: messages.slice(-5).map((m) => ({ id: m.id, labelIds: m.labelIds, ...headersOf(m.payload, LIST_HEADERS) })),
      };
    }),
  );
  return { threads, ...(list.nextPageToken ? { nextPageToken: list.nextPageToken } : {}) };
}

async function listDrafts(api: GmailApi, args: Record<string, unknown>) {
  const list = (await api("drafts", { query: { q: optionalText(args, "query"), maxResults: pageSize(args), pageToken: optionalText(args, "pageToken") } })) as {
    drafts?: { id: string }[];
    nextPageToken?: string;
  };
  const drafts = await Promise.all(
    (list.drafts ?? []).map(async (draft) => {
      const full = (await api(`drafts/${encodeURIComponent(draft.id)}`, { query: { format: "metadata" } })) as { id?: string; message?: GmailMessage };
      return {
        id: full.id ?? draft.id,
        messageId: full.message?.id,
        threadId: full.message?.threadId,
        viewUrl: full.message?.id ? `https://mail.google.com/mail/#drafts?compose=${full.message.id}` : undefined,
        snippet: full.message?.snippet,
        ...headersOf(full.message?.payload, ["To", "Cc", "Subject"]),
      };
    }),
  );
  return { drafts, ...(list.nextPageToken ? { nextPageToken: list.nextPageToken } : {}) };
}

const RUNNERS: Record<string, (api: GmailApi, args: Record<string, unknown>) => Promise<unknown>> = {
  search_threads: searchThreads,
  async get_thread(api, args) {
    const how = formatOf(args);
    const thread = (await api(`threads/${id(args, "threadId")}`, { query: { format: apiFormat(how) } })) as { id?: string; messages?: GmailMessage[] };
    const messages = (thread.messages ?? []).filter((m) => !m.labelIds?.includes("DRAFT"));
    return {
      id: thread.id,
      viewUrl: threadUrl(thread.id),
      messageCount: messages.length,
      messages: messages.slice(-MAX_THREAD_MESSAGES).map((m) => readMessage(m, how)),
      ...(messages.length > MAX_THREAD_MESSAGES ? { note: `only the last ${MAX_THREAD_MESSAGES} of ${messages.length} messages` } : {}),
    };
  },
  async get_message(api, args) {
    const how = formatOf(args);
    return readMessage((await api(`messages/${id(args, "messageId")}`, { query: { format: apiFormat(how) } })) as GmailMessage, how);
  },
  list_drafts: listDrafts,
  async get_draft(api, args) {
    const how = formatOf(args);
    const draft = (await api(`drafts/${id(args, "draftId")}`, { query: { format: apiFormat(how) } })) as { id?: string; message?: GmailMessage };
    return {
      id: draft.id,
      viewUrl: draft.message?.id ? `https://mail.google.com/mail/#drafts?compose=${draft.message.id}` : undefined,
      message: draft.message ? readMessage(draft.message, how) : undefined,
    };
  },
  async list_labels(api) {
    const list = (await api("labels")) as { labels?: { id?: string; name?: string; type?: string }[] };
    return { labels: (list.labels ?? []).map(({ id: labelId, name, type }) => ({ id: labelId, name, type })) };
  },
  async create_draft(api, args) {
    const draft = (await api("drafts", { method: "POST", body: { message: await outgoing(api, args) } })) as { id?: string; message?: GmailMessage };
    return {
      id: draft.id,
      messageId: draft.message?.id,
      threadId: draft.message?.threadId,
      viewUrl: draft.message?.id ? `https://mail.google.com/mail/#drafts?compose=${draft.message.id}` : undefined,
    };
  },
  async send_email(api, args) {
    const sent = (await api("messages/send", { method: "POST", body: await outgoing(api, args) })) as GmailMessage;
    return { sent: true, id: sent.id, threadId: sent.threadId, labelIds: sent.labelIds, viewUrl: threadUrl(sent.threadId) };
  },
};

function failure(text: string): GmailResult {
  return { content: [{ type: "text", text }], isError: true };
}

export async function runGmailTool(api: GmailApi, name: string, args: Record<string, unknown>): Promise<GmailResult> {
  const run = RUNNERS[name];
  if (!run) return failure(`Gmail has no action named ${name}`);
  try {
    return { content: [{ type: "text", text: JSON.stringify(await run(api, args)) }] };
  } catch (error) {
    if (error instanceof InputError) return failure(`not called: ${error.message}`);
    if (error instanceof GmailError) {
      const hint = error.status === 403 ? " The owner's Google sign-in may not allow this; they can sign in again from the understudy's settings." : "";
      return failure(`Gmail answered ${error.status}: ${error.message}.${hint}`);
    }
    throw error;
  }
}
