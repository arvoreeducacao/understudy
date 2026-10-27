import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { PATHS } from "@understudy/protocol";
import { getDb, schema } from "@/lib/db";
import type { BrainAccount } from "@/lib/db/schema";
import { open } from "@/lib/secret-box";
import { safeFetch } from "./safe-fetch";

export const DEFAULT_MODEL_URL = "https://api.anthropic.com";

const FORWARDED_PATHS = new Set(["/v1/messages", "/v1/messages/count_tokens"]);
const FORWARDED_REQUEST_HEADERS = ["content-type", "accept", "anthropic-version", "anthropic-beta"];
const FORWARDED_RESPONSE_HEADERS = ["content-type", "request-id", "retry-after", "x-should-retry"];
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const TOKEN_PREFIX = "mdl_";

function log(event: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
}

function signingKey() {
  const secret = process.env.UNDERSTUDY_SECRET_KEY?.trim() || process.env.BETTER_AUTH_SECRET?.trim();
  if (!secret) throw new Error("UNDERSTUDY_SECRET_KEY or BETTER_AUTH_SECRET must be set");
  return createHash("sha256").update(`${secret}:understudy-model-token`).digest();
}

function signature(agentId: string, tokenHash: string) {
  return createHmac("sha256", signingKey()).update(`${agentId}\n${tokenHash}`).digest("base64url");
}

export function modelToken(agent: { id: string; tokenHash: string }) {
  return `${TOKEN_PREFIX}${agent.id}.${signature(agent.id, agent.tokenHash)}`;
}

export function brainAccountKey(token: string) {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

export function brainAccountMessage(agent: { id: string; tokenHash: string; brainAccount: BrainAccount | null }) {
  if (!agent.brainAccount) return { type: "set_brain_account" as const, token: "" };
  return { type: "set_brain_account" as const, token: modelToken(agent), ...(agent.brainAccount.maxUsdPerTurn ? { maxUsdPerTurn: agent.brainAccount.maxUsdPerTurn } : {}) };
}

export function sameBrainAccount(wanted: { token: string; maxUsdPerTurn?: number }, reported: { key: string; maxUsdPerTurn?: number } | undefined) {
  if (!wanted.token) return !reported;
  return Boolean(reported) && reported?.key === brainAccountKey(wanted.token) && (reported?.maxUsdPerTurn ?? null) === (wanted.maxUsdPerTurn ?? null);
}

function presentedToken(req: IncomingMessage) {
  const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const apiKey = req.headers["x-api-key"];
  return bearer || (typeof apiKey === "string" ? apiKey.trim() : "");
}

async function accountFor(token: string) {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const [agentId, given] = token.slice(TOKEN_PREFIX.length).split(".");
  if (!agentId || !given) return null;
  const [row] = await getDb()
    .select({ id: schema.agents.id, tokenHash: schema.agents.tokenHash, brainAccount: schema.agents.brainAccount, ownerStatus: schema.user.status })
    .from(schema.agents)
    .innerJoin(schema.user, eq(schema.user.id, schema.agents.ownerId))
    .where(eq(schema.agents.id, agentId));
  if (!row?.brainAccount || row.ownerStatus !== "approved") return null;
  const expected = Buffer.from(signature(row.id, row.tokenHash));
  const actual = Buffer.from(given);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return { agentId: row.id, account: row.brainAccount };
}

function fail(res: ServerResponse, status: number, type: string, message: string) {
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type, message } }));
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export function upstreamUrl(account: Pick<BrainAccount, "url">, path: string, search: string) {
  const base = (account.url || DEFAULT_MODEL_URL).replace(/\/+$/, "");
  return `${base}${path}${search}`;
}

export function isModelProxyRoute(pathname: string) {
  return pathname.startsWith(`${PATHS.modelProxy}/`);
}

export async function handleModelProxy(req: IncomingMessage, res: ServerResponse, url: URL) {
  const path = url.pathname.slice(PATHS.modelProxy.length);
  if (req.method !== "POST" || !FORWARDED_PATHS.has(path)) return fail(res, 404, "not_found_error", "not found");
  const found = await accountFor(presentedToken(req));
  if (!found) return fail(res, 401, "authentication_error", "this understudy has no key of its own, or the token is not valid");
  const body = await readBody(req);
  if (!body) return fail(res, 413, "request_too_large", "request too large");
  const headers: Record<string, string> = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  const key = open(found.account.key);
  if (found.account.auth === "bearer") headers.authorization = `Bearer ${key}`;
  else headers["x-api-key"] = key;
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  let upstream: Response;
  try {
    upstream = await safeFetch(upstreamUrl(found.account, path, url.search), { method: "POST", headers, body, signal: controller.signal });
  } catch (error) {
    log("model_proxy_unreachable", { agentId: found.agentId, error: String(error).slice(0, 200) });
    return fail(res, 502, "api_error", "the model provider could not be reached");
  }
  const out: Record<string, string> = {};
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) out[name] = value;
  }
  if (upstream.status >= 400) log("model_proxy_refused", { agentId: found.agentId, status: upstream.status });
  res.writeHead(upstream.status, out);
  if (!upstream.body) return res.end();
  Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream).on("error", () => res.destroy()).pipe(res);
}
