import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { promisify } from "node:util";
import { gitPushApproval, handleGitProxy, type GitAccess, type GitProxyDeps, type GitPush, type PushGate } from "./git-proxy";

const run = promisify(execFile);
const root = mkdtempSync(join(tmpdir(), "git-proxy-"));
const upstreamRoot = join(root, "upstream");
const gitEnv = { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Ada", GIT_AUTHOR_EMAIL: "ada@example.com", GIT_COMMITTER_NAME: "Ada", GIT_COMMITTER_EMAIL: "ada@example.com" };

type Agent = { id: string };

let upstream: Server;
let panel: Server;
let panelUrl = "";
let seenAuth: string[] = [];
let access: GitAccess;
let gate: (push: GitPush, onAsk: () => void) => Promise<PushGate>;
let pushes: GitPush[] = [];
let finished: { ok: boolean; note: string }[] = [];

function listen(server: Server) {
  return new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

function gitBackend() {
  return createServer((req, res) => {
    seenAuth.push(req.headers.authorization ?? "");
    const url = new URL(req.url ?? "/", "http://upstream");
    const child = spawn("git", ["http-backend"], {
      env: {
        ...gitEnv,
        GIT_PROJECT_ROOT: upstreamRoot,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method ?? "GET",
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        ...(req.headers["content-length"] ? { CONTENT_LENGTH: req.headers["content-length"] } : {}),
        ...(req.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: req.headers["content-encoding"] } : {}),
        GIT_PROTOCOL: String(req.headers["git-protocol"] ?? ""),
        REMOTE_USER: "app",
        REMOTE_ADDR: "127.0.0.1",
      },
    });
    req.pipe(child.stdin);
    let head = Buffer.alloc(0);
    let started = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (started) return res.write(chunk);
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of head.subarray(0, end).toString().split("\r\n")) {
        const [name, ...value] = line.split(":");
        if (name.toLowerCase() === "status") status = Number.parseInt(value.join(":").trim(), 10);
        else headers[name] = value.join(":").trim();
      }
      res.writeHead(status, headers);
      started = true;
      res.write(head.subarray(end + 4));
    });
    child.stdout.on("end", () => res.end());
  });
}

function deps(base: string): GitProxyDeps<Agent> {
  return {
    authenticate: async (authorization) => (authorization === "Bearer computer-token" ? { id: "agt_1" } : null),
    access: async () => access,
    token: async () => "ghs_app",
    defaultBranch: async () => "main",
    gatePush: async (_agent, push, onAsk) => {
      pushes.push(push);
      const result = await gate(push, onAsk);
      if (!result.ok) return result;
      return { ok: true, finish: async (ok, note) => void finished.push({ ok, note }) };
    },
    upstream: base,
    fetch,
  };
}

async function git(args: string[], cwd = root) {
  return run("git", ["-c", "http.extraHeader=Authorization: Bearer computer-token", ...args], { cwd, env: gitEnv });
}

async function gitFails(args: string[], cwd = root) {
  try {
    await git(args, cwd);
  } catch (error) {
    return String((error as { stderr?: string }).stderr ?? error);
  }
  assert.fail(`git ${args.join(" ")} should have failed`);
}

async function upstreamBranches() {
  const { stdout } = await run("git", ["--git-dir", join(upstreamRoot, "acme", "widgets.git"), "branch", "--format=%(refname:short)"], { env: gitEnv });
  return stdout.split("\n").filter(Boolean).sort();
}

const remote = () => `${panelUrl}/api/git/github.com/acme/widgets.git`;
let clones = 0;

async function freshClone() {
  const dir = join(root, `clone-${++clones}`);
  await git(["clone", "-q", remote(), dir]);
  return dir;
}

async function commit(dir: string, name: string) {
  writeFileSync(join(dir, name), `${name}\n`);
  await run("git", ["add", name], { cwd: dir, env: gitEnv });
  await run("git", ["commit", "-qm", `add ${name}`], { cwd: dir, env: gitEnv });
}

before(async () => {
  const bare = join(upstreamRoot, "acme", "widgets.git");
  await run("git", ["init", "-q", "--bare", "-b", "main", bare], { env: gitEnv });
  const seed = join(root, "seed");
  await run("git", ["init", "-q", "-b", "main", seed], { env: gitEnv });
  await commit(seed, "README");
  await run("git", ["push", "-q", bare, "main"], { cwd: seed, env: gitEnv });
  upstream = gitBackend();
  const base = await listen(upstream);
  const handler = deps(base);
  panel = createServer((req, res) => {
    handleGitProxy(req, res, new URL(req.url ?? "/", "http://panel"), handler).catch(() => res.destroy());
  });
  panelUrl = await listen(panel);
});

after(() => {
  panel.close();
  upstream.close();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  seenAuth = [];
  pushes = [];
  finished = [];
  access = { connected: true, read: true, push: "allow" };
  gate = async () => ({ ok: true, finish: async () => undefined });
});

test("a clone goes through the panel, which signs in to GitHub as the app", async () => {
  await freshClone();
  assert.ok(seenAuth.length > 0);
  assert.ok(seenAuth.every((auth) => auth === `Basic ${Buffer.from("x-access-token:ghs_app").toString("base64")}`));
});

test("without the connector a clone still works, anonymously", async () => {
  access = { connected: false, read: false, push: "never" };
  await freshClone();
  assert.ok(seenAuth.every((auth) => auth === ""));
});

test("an allowed push of a new branch reaches GitHub and is recorded", async () => {
  const dir = await freshClone();
  await run("git", ["switch", "-qc", "feature"], { cwd: dir, env: gitEnv });
  await commit(dir, "feature.txt");
  await git(["push", "-q", "origin", "feature"], dir);
  assert.deepEqual(await upstreamBranches(), ["feature", "main"]);
  assert.deepEqual(pushes, [{ repository: "acme/widgets", refs: ["refs/heads/feature"], toDefaultBranch: false }]);
  assert.deepEqual(finished, [{ ok: true, note: "GitHub answered 200" }]);
});

test("a push to the default branch is flagged so the gate always asks", async () => {
  const dir = await freshClone();
  await commit(dir, "direct.txt");
  await git(["push", "-q", "origin", "main"], dir);
  assert.equal(pushes[0]?.toDefaultBranch, true);
});

test("a push the owner turned off fails before anything is sent, with the reason", async () => {
  access = { connected: true, read: true, push: "never" };
  const dir = await freshClone();
  await run("git", ["switch", "-qc", "blocked"], { cwd: dir, env: gitEnv });
  await commit(dir, "blocked.txt");
  const stderr = await gitFails(["push", "origin", "blocked"], dir);
  assert.match(stderr, /remote error: your owner turned off pushing to GitHub/);
  assert.equal(pushes.length, 0);
  assert.ok(!(await upstreamBranches()).includes("blocked"));
});

test("without the connector a push is refused and says what is missing", async () => {
  access = { connected: false, read: false, push: "never" };
  const dir = await freshClone();
  await commit(dir, "anon.txt");
  const stderr = await gitFails(["push", "origin", "main"], dir);
  assert.match(stderr, /remote error: this understudy has no GitHub connector/);
});

test("while answering someone other than the owner, git cannot push and reads anonymously", async () => {
  access = { connected: true, read: false, push: "never", refusal: "not available while you are answering someone other than your owner" };
  const dir = await freshClone();
  assert.ok(seenAuth.every((auth) => auth === ""));
  await commit(dir, "outsider.txt");
  const stderr = await gitFails(["push", "origin", "main"], dir);
  assert.match(stderr, /remote error: not available while you are answering someone other than your owner/);
});

test("deleting a branch is refused without asking anyone", async () => {
  const dir = await freshClone();
  await run("git", ["switch", "-qc", "doomed"], { cwd: dir, env: gitEnv });
  await commit(dir, "doomed.txt");
  await git(["push", "-q", "origin", "doomed"], dir);
  pushes = [];
  const stderr = await gitFails(["push", "origin", "--delete", "doomed"], dir);
  assert.match(stderr, /\[remote rejected\] doomed \(deleting a branch or a tag is not allowed through the panel\)/);
  assert.equal(pushes.length, 0);
  assert.ok((await upstreamBranches()).includes("doomed"));
});

test("while the owner decides, git shows that it is waiting, and a denial rejects the push", async () => {
  gate = async (_push, onAsk) => {
    onAsk();
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { ok: false, reason: "the owner denied this" };
  };
  const dir = await freshClone();
  await run("git", ["switch", "-qc", "asked"], { cwd: dir, env: gitEnv });
  await commit(dir, "asked.txt");
  const stderr = await gitFails(["push", "origin", "asked"], dir);
  assert.match(stderr, /remote: waiting for your owner to approve this push/);
  assert.match(stderr, /\[remote rejected\] asked -> asked \(the owner denied this\)/);
  assert.ok(!(await upstreamBranches()).includes("asked"));
});

test("an approved push goes through after the wait", async () => {
  gate = async (_push, onAsk) => {
    onAsk();
    return { ok: true, finish: async () => undefined };
  };
  const dir = await freshClone();
  await run("git", ["switch", "-qc", "approved"], { cwd: dir, env: gitEnv });
  await commit(dir, "approved.txt");
  await git(["push", "-q", "origin", "approved"], dir);
  assert.ok((await upstreamBranches()).includes("approved"));
  assert.deepEqual(finished, [{ ok: true, note: "GitHub answered 200" }]);
});

test("a computer that is not signed in gets nothing", async () => {
  const response = await fetch(`${remote()}/info/refs?service=git-upload-pack`);
  assert.equal(response.status, 401);
  assert.equal(seenAuth.length, 0);
});

test("only github.com repositories are proxied", async () => {
  const response = await fetch(`${panelUrl}/api/git/example.com/acme/widgets.git/info/refs?service=git-upload-pack`, { headers: { Authorization: "Bearer computer-token" } });
  assert.equal(response.status, 404);
});

const labels = { connector: "Connector", action: "Action", repository: "Repository", branches: "Branches", warning: "Heads up", defaultBranchWarning: "straight to main" };

test("an allowed push to a branch goes on its own; the main branch, ask and a hand-off always ask", () => {
  const branch = { repository: "acme/widgets", refs: ["refs/heads/feature"], toDefaultBranch: false };
  assert.equal(gitPushApproval(branch, "allow", false, "GitHub", labels).ask, false);
  assert.equal(gitPushApproval(branch, "ask", false, "GitHub", labels).ask, true);
  assert.equal(gitPushApproval(branch, "allow", true, "GitHub", labels).ask, true);
  const main = gitPushApproval({ ...branch, refs: ["refs/heads/main", "refs/heads/feature"], toDefaultBranch: true }, "allow", false, "GitHub", labels);
  assert.equal(main.ask, true);
  assert.deepEqual(main.fields, [
    { label: "Connector", value: "GitHub" },
    { label: "Action", value: "git push" },
    { label: "Repository", value: "acme/widgets" },
    { label: "Branches", value: "refs/heads/main\nrefs/heads/feature" },
    { label: "Heads up", value: "straight to main" },
  ]);
});
