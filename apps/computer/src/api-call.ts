import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describeRule, type OwnerRule } from "@understudy/protocol";
import { redactSecrets, ruleBlockText, scriptRequestVerdict } from "./browser-guard.ts";
import { uniqueTarget } from "./files.ts";
import type { ApprovalRequest } from "./gatekeeper-client.ts";
import type { TurnState } from "./turn-state.ts";
import { hostMatches, type Revealed, type Vault } from "./vault.ts";

export const API_METHODS = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"];

export const INLINE_LIMIT = 20 * 1024;

export const PREVIEW_LIMIT = 2 * 1024;

export const RESPONSE_LIMIT = 25 * 1024 * 1024;

export const REQUEST_BODY_LIMIT = 1024 * 1024;

export const API_TIMEOUT_MS = 60_000;

const BLOCKED_HEADERS = /^(host|content-length|transfer-encoding|connection|cookie|proxy-authorization)$/i;

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;

const TEXTUAL = /json|^text\/|xml|javascript|urlencoded|csv|yaml/i;

const SHOWN_HEADERS = /^(link|retry-after|location|x-total-count|x-next-page|x-ratelimit-[a-z-]+|ratelimit-[a-z-]+)$/i;

export type ApiCallArgs = { name?: unknown; method?: unknown; url?: unknown; headers?: unknown; body?: unknown; saveAs?: unknown };

export type ApiCallDeps = {
  filesDir: string;
  state: () => TurnState;
  rules: () => OwnerRule[];
  approve: (request: ApprovalRequest) => Promise<{ approved: boolean; text: string }>;
  notify?: (event: Record<string, unknown>) => Promise<void>;
  fetch?: typeof fetch;
};

export function apiTarget(site: string, raw: string): URL | string {
  const text = raw.trim();
  if (!text) return "Give the url (https://...) or a path that starts with /.";
  let url: URL;
  try {
    url = new URL(text.startsWith("/") ? `https://${site}${text}` : text);
  } catch {
    return "That url is not valid.";
  }
  if (url.protocol !== "https:") return "Refused: an API key is only sent over https.";
  if (url.username || url.password) return "Refused: the url cannot carry a login.";
  if (!hostMatches(site, url.href)) return `Refused: this key is only for ${site || "its own site"}.`;
  return url;
}

export function requestHeaders(raw: unknown, authHeader: string | null): Record<string, string> | string {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) return "headers must be an object of header name to value.";
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw).slice(0, 40)) {
    if (!HEADER_NAME.test(name) || BLOCKED_HEADERS.test(name)) continue;
    if (authHeader && name.toLowerCase() === authHeader.toLowerCase()) continue;
    const text = String(value ?? "");
    if (/[\r\n]/.test(text) || text.length > 4000) continue;
    out[name] = text;
  }
  return out;
}

export function requestBody(raw: unknown): { text?: string; json: boolean } | string {
  if (raw === undefined || raw === null || raw === "") return { json: false };
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  if (Buffer.byteLength(text) > REQUEST_BODY_LIMIT) return `The body is over ${REQUEST_BODY_LIMIT / 1024 / 1024} MB.`;
  return { text, json: typeof raw !== "string" };
}

export function authHeaderOf(credential: Revealed): string | null {
  if (credential.sendAs === "query") return null;
  if (credential.sendAs === "header") return credential.field ?? null;
  return "Authorization";
}

export function basicToken(credential: Revealed): string {
  return Buffer.from(`${credential.username}:${credential.secret}`).toString("base64");
}

export function withKey(credential: Revealed, url: URL, headers: Record<string, string>): void {
  if (credential.sendAs === "query" && credential.field) url.searchParams.set(credential.field, credential.secret);
  else if (credential.sendAs === "header" && credential.field) headers[credential.field] = credential.secret;
  else if (credential.sendAs === "basic") headers.Authorization = `Basic ${basicToken(credential)}`;
  else headers.Authorization = `Bearer ${credential.secret}`;
}

async function readLimited(response: Response, limit: number): Promise<{ bytes: Buffer; truncated: boolean }> {
  if (!response.body) return { bytes: Buffer.alloc(0), truncated: false };
  const reader = response.body.getReader();
  const parts: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { bytes: Buffer.concat(parts), truncated: false };
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return { bytes: Buffer.concat(parts), truncated: true };
    }
    parts.push(Buffer.from(value));
  }
}

function extensionOf(type: string): string {
  if (/json/i.test(type)) return "json";
  if (/csv/i.test(type)) return "csv";
  if (/html/i.test(type)) return "html";
  if (/xml/i.test(type)) return "xml";
  if (/^text\//i.test(type)) return "txt";
  return "bin";
}

function sizeText(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function saveBody(filesDir: string, name: string, saveAs: unknown, type: string, content: Buffer | string): string {
  const dir = join(filesDir, "api");
  mkdirSync(dir, { recursive: true });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("~/files/api is a link; refusing to write through it");
  const wanted = typeof saveAs === "string" && saveAs.trim() ? basename(saveAs.trim()) : `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.${extensionOf(type)}`;
  const target = uniqueTarget(dir, wanted);
  writeFileSync(target, content, { flag: "wx" });
  return target;
}

export async function callApi(vault: Vault, args: ApiCallArgs, deps: ApiCallDeps): Promise<string> {
  const name = String(args.name ?? "");
  const credential = vault.reveal(name);
  if (!credential) return `No saved API key named "${name}". Ask your owner to add it under Logins in the panel.`;
  if (credential.kind !== "api_key") return `Refused: "${name}" is a site login, not an API key. Use fill_credential on its site instead.`;
  const method = String(args.method ?? "GET").toUpperCase();
  if (!API_METHODS.includes(method)) return `Refused: the method must be one of ${API_METHODS.join(", ")}.`;
  const url = apiTarget(credential.site ?? "", String(args.url ?? ""));
  if (typeof url === "string") return url;
  if (credential.sendAs === "query" && credential.field) url.searchParams.delete(credential.field);
  const headers = requestHeaders(args.headers, authHeaderOf(credential));
  if (typeof headers === "string") return headers;
  const body = requestBody(args.body);
  if (typeof body === "string") return body;
  if (body.text !== undefined && (method === "GET" || method === "HEAD")) return "GET and HEAD calls carry no body; put the parameters in the url.";
  if (body.json && !Object.keys(headers).some((header) => header.toLowerCase() === "content-type")) headers["Content-Type"] = "application/json";

  const secrets = [...vault.list().map((entry) => vault.reveal(entry.name)?.secret ?? ""), credential.sendAs === "basic" ? basicToken(credential) : ""];
  const clean = (text: string) => redactSecrets(text, secrets);
  const shown = url.href;
  const shownBody = body.text === undefined ? undefined : clean(body.text);
  const state = deps.state();
  const verdict = scriptRequestVerdict(state, deps.rules(), { method, url: shown, body: shownBody, pageUrl: "" });
  if (verdict.kind === "rule") {
    await deps.notify?.({ event: "rule_blocked", ruleId: verdict.violation.rule.id, rule: describeRule(verdict.violation.rule), detail: verdict.violation.reason });
    return ruleBlockText(verdict.violation);
  }
  if (verdict.kind === "block") return verdict.reason;
  if (verdict.kind === "ask") {
    const step = verdict.fields.find((field) => field.label === "Step");
    const answer = await deps.approve({
      summary: `Call the ${name} API: ${method} ${url.host}${url.pathname}`.slice(0, 480),
      runId: state.runId,
      stepId: verdict.stepId,
      fields: [
        ...(step ? [step] : []),
        { label: "Saved key", value: name },
        { label: "Request", value: `${method} ${shown}`.slice(0, 2000) },
        ...(shownBody ? [{ label: "Body", value: shownBody.slice(0, 4000) }] : []),
      ],
    });
    if (!answer.approved) return `Not sent: your owner did not approve this call. ${clean(answer.text).slice(0, 300)}`;
  }

  withKey(credential, url, headers);
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(url, { method, headers, body: body.text, redirect: "manual", signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  } catch (error) {
    return `Failed: ${clean(String((error as Error).message ?? error))}`;
  }
  const type = response.headers.get("content-type") ?? "";
  const extra = [...response.headers.entries()].filter(([header]) => SHOWN_HEADERS.test(header)).map(([header, value]) => `${header}: ${clean(value)}`);
  const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    return [`${status}. Redirects are not followed, so the key went nowhere else. If the new address is on ${credential.site}, call it yourself.`, ...extra].join("\n");
  }
  const { bytes, truncated } = await readLimited(response, RESPONSE_LIMIT);
  const textual = TEXTUAL.test(type) || (!type && !bytes.includes(0));
  const text = textual ? clean(bytes.toString("utf8")) : "";
  const head = [`${status} · ${type || "no content type"} · ${sizeText(bytes.length)}${truncated ? " (cut at the size limit)" : ""}`, ...extra];
  if (method === "HEAD" || bytes.length === 0) return head.join("\n");
  const save = (typeof args.saveAs === "string" && args.saveAs.trim() !== "") || !textual || Buffer.byteLength(text) > INLINE_LIMIT || truncated;
  if (!save) return [...head, "", text].join("\n");
  let path: string;
  try {
    path = saveBody(deps.filesDir, name, args.saveAs, type, textual ? text : bytes);
  } catch (error) {
    return [...head, `Could not save the body: ${(error as Error).message}`].join("\n");
  }
  return [...head, `The body was saved to ${path}. Read it from there.`, ...(textual ? ["First part:", text.slice(0, PREVIEW_LIMIT)] : [])].join("\n");
}
