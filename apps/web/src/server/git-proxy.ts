import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { PATHS } from "@understudy/protocol";
import { deletes, parseGitRoute, progress, readPushRequest, refusedAdvertisement, refusedPush, type GitRoute, type GitService, type PushRequest } from "./git-wire";

const MAX_BODY_BYTES = 100 * 1024 * 1024;
const KEEPALIVE_MS = 20_000;
const FORWARDED_REQUEST_HEADERS = ["content-type", "accept", "git-protocol", "user-agent"];
const FORWARDED_RESPONSE_HEADERS = ["content-type", "cache-control", "expires", "pragma"];
const GUESSED_DEFAULT_BRANCHES = ["main", "master"];

export type GitPermission = "allow" | "ask" | "never";

export type GitAccess = { connected: boolean; read: boolean; push: GitPermission; refusal?: string };

export type GitPush = { repository: string; refs: string[]; toDefaultBranch: boolean };

export type PushGate = { ok: true; finish: (ok: boolean, note: string) => Promise<void> } | { ok: false; reason: string };

export type GitProxyDeps<A> = {
  authenticate: (authorization: string | undefined) => Promise<A | null>;
  access: (agent: A) => Promise<GitAccess>;
  token: () => Promise<string>;
  defaultBranch: (owner: string, repo: string, token: string) => Promise<string | null>;
  gatePush: (agent: A, push: GitPush, onAsk: () => void, signal: AbortSignal) => Promise<PushGate>;
  upstream: string;
  fetch: typeof fetch;
};

export type GitPushLabels = { connector: string; action: string; repository: string; branches: string; warning: string; defaultBranchWarning: string };

export function gitPushApproval(push: GitPush, permission: GitPermission, handedOff: boolean, connector: string, labels: GitPushLabels) {
  const ask = permission === "ask" || push.toDefaultBranch || handedOff;
  const fields = [
    { label: labels.connector, value: connector },
    { label: labels.action, value: "git push" },
    { label: labels.repository, value: push.repository },
    { label: labels.branches, value: push.refs.join("\n") },
    ...(push.toDefaultBranch ? [{ label: labels.warning, value: labels.defaultBranchWarning }] : []),
  ];
  return { ask, fields };
}

export function isGitProxyRoute(pathname: string) {
  return pathname.startsWith(`${PATHS.gitProxy}/`);
}

function plain(res: ServerResponse, status: number, text: string) {
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(`${text}\n`);
}

function answer(res: ServerResponse, type: string, body: Buffer) {
  if (!res.headersSent) res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
  res.end(body);
}

function contentType(service: GitService, advertise: boolean) {
  return `application/x-${service}-${advertise ? "advertisement" : "result"}`;
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

export function pushRefusal(access: GitAccess) {
  if (access.refusal) return access.refusal;
  if (!access.connected) return "this understudy has no GitHub connector run by the panel, so it cannot push; ask your owner to add the GitHub connector";
  if (access.push === "never") return "your owner turned off pushing to GitHub (push_files) for you; do not try another way, tell your owner if you need it";
  return null;
}

export function upstreamUrl(base: string, route: GitRoute) {
  const path = route.advertise ? `info/refs?service=${route.service}` : route.service;
  return `${base.replace(/\/+$/, "")}/${route.owner}/${route.repo}.git/${path}`;
}

function forwardedHeaders(req: IncomingMessage, route: GitRoute, token: string | null) {
  const headers: Record<string, string> = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  const encoding = req.headers["content-encoding"];
  if (route.service === "git-upload-pack" && typeof encoding === "string") headers["content-encoding"] = encoding;
  if (token) headers.authorization = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  return headers;
}

function relay(res: ServerResponse, upstream: Response) {
  const headers: Record<string, string> = {};
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  res.writeHead(upstream.status === 401 ? 403 : upstream.status, headers);
  pipeBody(res, upstream);
}

function pipeBody(res: ServerResponse, upstream: Response) {
  if (!upstream.body) return res.end();
  Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream).on("error", () => res.destroy()).pipe(res);
}

function touchesDefaultBranch(request: PushRequest, head: string | null) {
  const names = head ? [head] : GUESSED_DEFAULT_BRANCHES;
  return request.commands.some((command) => names.some((name) => command.ref === `refs/heads/${name}`));
}

async function push<A>(
  res: ServerResponse,
  route: GitRoute,
  request: PushRequest,
  agent: A,
  deps: GitProxyDeps<A>,
  token: string,
  forward: () => Promise<Response>,
  signal: AbortSignal,
) {
  const type = contentType(route.service, false);
  if (request.commands.some(deletes)) return answer(res, type, refusedPush(request, "deleting a branch or a tag is not allowed through the panel"));
  const head = await deps.defaultBranch(route.owner, route.repo, token).catch(() => null);
  let keepalive: NodeJS.Timeout | undefined;
  const onAsk = () => {
    if (res.headersSent) return;
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
    const waiting = progress(request.capabilities, "waiting for your owner to approve this push");
    res.write(waiting);
    keepalive = setInterval(() => res.write(waiting), KEEPALIVE_MS);
  };
  const refs = request.commands.map((command) => command.ref);
  const gate = await deps
    .gatePush(agent, { repository: `${route.owner}/${route.repo}`, refs, toDefaultBranch: touchesDefaultBranch(request, head) }, onAsk, signal)
    .finally(() => clearInterval(keepalive));
  if (!gate.ok) return answer(res, type, refusedPush(request, gate.reason));
  let upstream: Response;
  try {
    upstream = await forward();
  } catch {
    await gate.finish(false, "GitHub could not be reached");
    return res.headersSent ? res.end(refusedPush(request, "GitHub could not be reached")) : plain(res, 502, "GitHub could not be reached");
  }
  await gate.finish(upstream.ok, `GitHub answered ${upstream.status}`);
  if (!res.headersSent) return relay(res, upstream);
  if (!upstream.ok) return res.end(refusedPush(request, `GitHub answered ${upstream.status}`));
  pipeBody(res, upstream);
}

export async function handleGitProxy<A>(req: IncomingMessage, res: ServerResponse, url: URL, deps: GitProxyDeps<A>) {
  const route = parseGitRoute(url.pathname.slice(PATHS.gitProxy.length), url.searchParams);
  if (!route) return plain(res, 404, "only repositories on github.com go through the panel");
  if (req.method !== (route.advertise ? "GET" : "POST")) return plain(res, 405, "method not allowed");
  const agent = await deps.authenticate(req.headers.authorization);
  if (!agent) return plain(res, 401, "this computer is not signed in to the panel");
  const access = await deps.access(agent);
  const pushing = route.service === "git-receive-pack";
  const refusal = pushing ? pushRefusal(access) : null;
  if (refusal) return route.advertise ? answer(res, contentType(route.service, true), refusedAdvertisement(route.service, refusal)) : plain(res, 403, refusal);
  if (pushing && req.headers["content-encoding"]) return plain(res, 415, "compressed pushes are not supported");
  const body = route.advertise ? undefined : await readBody(req);
  if (body === null) return plain(res, 413, "the request is too large for the panel");
  const token = pushing || (access.connected && access.read) ? await deps.token() : null;
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  const forward = () =>
    deps.fetch(upstreamUrl(deps.upstream, route), { method: req.method, headers: forwardedHeaders(req, route, token), body, redirect: "error", signal: controller.signal });
  if (pushing && body) {
    const request = readPushRequest(body);
    if (!request) return plain(res, 400, "the push could not be read");
    if (request.commands.length > 0) return push(res, route, request, agent, deps, token ?? "", forward, controller.signal);
  }
  let upstream: Response;
  try {
    upstream = await forward();
  } catch {
    return plain(res, 502, "GitHub could not be reached");
  }
  relay(res, upstream);
}
