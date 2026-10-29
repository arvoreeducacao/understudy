import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { gitProxyUrl } from "./endpoints.ts";

const FORWARDED_REQUEST_HEADERS = ["content-type", "content-length", "content-encoding", "accept", "git-protocol", "user-agent"];
const FORWARDED_RESPONSE_HEADERS = ["content-type", "content-length", "cache-control", "expires", "pragma"];
const GITHUB_REMOTES = ["https://github.com/", "git@github.com:", "ssh://git@github.com/"];

export type GitForward = { port: number; close: () => void };

export function forwardTarget(serverUrl: string, path: string): URL | null {
  if (!path.startsWith("/github.com/")) return null;
  return new URL(`${gitProxyUrl(serverUrl)}${path}`);
}

function pick(headers: IncomingHttpHeaders, names: string[]) {
  const picked: Record<string, string> = {};
  for (const name of names) {
    const value = headers[name];
    if (typeof value === "string") picked[name] = value;
  }
  return picked;
}

export function startGitForward(serverUrl: string, token: string): Promise<GitForward> {
  const server = createServer((req, res) => {
    const target = forwardTarget(serverUrl, req.url ?? "/");
    if (!target) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("only repositories on github.com go through the panel\n");
      return;
    }
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const outgoing = send(target, { method: req.method, headers: { ...pick(req.headers, FORWARDED_REQUEST_HEADERS), authorization: `Bearer ${token}` } }, (incoming) => {
      res.writeHead(incoming.statusCode ?? 502, pick(incoming.headers, FORWARDED_RESPONSE_HEADERS));
      incoming.pipe(res);
    });
    outgoing.on("error", () => {
      if (res.headersSent) return res.destroy();
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("the panel could not be reached\n");
    });
    res.on("close", () => outgoing.destroy());
    req.pipe(outgoing);
  });
  server.requestTimeout = 0;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as AddressInfo).port, close: () => server.close() }));
  });
}

export function gitConfigText(port: number) {
  return [`[url "http://127.0.0.1:${port}/github.com/"]`, ...GITHUB_REMOTES.map((remote) => `\tinsteadOf = ${remote}`), ""].join("\n");
}

function includedPaths(globalConfig: string) {
  try {
    return execFileSync("git", ["config", "--file", globalConfig, "--get-all", "include.path"], { encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export function installGitConfig(home: string, port: number) {
  const file = join(home, ".understudy", "gitconfig");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, gitConfigText(port));
  const globalConfig = join(home, ".gitconfig");
  if (!includedPaths(globalConfig).includes(file)) execFileSync("git", ["config", "--file", globalConfig, "--add", "include.path", file]);
  return file;
}
