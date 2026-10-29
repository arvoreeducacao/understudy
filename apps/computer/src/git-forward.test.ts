import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { forwardTarget, gitConfigText, installGitConfig, startGitForward } from "./git-forward.ts";

test("only github.com paths are forwarded, to the panel's git route", () => {
  assert.equal(forwardTarget("https://panel.example.com/", "/github.com/acme/widgets.git/info/refs?service=git-upload-pack")?.href, "https://panel.example.com/api/git/github.com/acme/widgets.git/info/refs?service=git-upload-pack");
  assert.equal(forwardTarget("https://panel.example.com", "/gitlab.com/acme/widgets.git/info/refs"), null);
});

test("the forwarder adds the computer's token and passes the body and the answer through", async () => {
  const seen: { url?: string; auth?: string; body: string }[] = [];
  const panel = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body });
      res.writeHead(200, { "Content-Type": "application/x-git-receive-pack-result", "Set-Cookie": "x=y" });
      res.end("0000");
    });
  });
  await new Promise<void>((resolve) => panel.listen(0, "127.0.0.1", resolve));
  const forward = await startGitForward(`http://127.0.0.1:${(panel.address() as AddressInfo).port}`, "computer-token");
  try {
    const response = await fetch(`http://127.0.0.1:${forward.port}/github.com/acme/widgets.git/git-receive-pack`, { method: "POST", body: "0000", headers: { "Content-Type": "application/x-git-receive-pack-request", Authorization: "Bearer someone-else" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/x-git-receive-pack-result");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(await response.text(), "0000");
    assert.deepEqual(seen, [{ url: "/api/git/github.com/acme/widgets.git/git-receive-pack", auth: "Bearer computer-token", body: "0000" }]);
    const other = await fetch(`http://127.0.0.1:${forward.port}/example.com/acme/widgets.git/info/refs`);
    assert.equal(other.status, 404);
    assert.equal(seen.length, 1);
  } finally {
    forward.close();
    panel.close();
  }
});

test("git on the computer sends every github.com remote through the forwarder, and the setup is idempotent", () => {
  const home = mkdtempSync(join(tmpdir(), "git-forward-"));
  try {
    installGitConfig(home, 4321);
    const file = installGitConfig(home, 4322);
    assert.equal(readFileSync(file, "utf8"), gitConfigText(4322));
    const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
    assert.equal(execFileSync("git", ["config", "--global", "--get-all", "include.path"], { env, encoding: "utf8" }).trim(), file);
    for (const remote of ["https://github.com/acme/widgets", "git@github.com:acme/widgets.git"]) {
      const url = execFileSync("git", ["ls-remote", "--get-url", remote], { env, encoding: "utf8", cwd: home }).trim();
      assert.match(url, /^http:\/\/127\.0\.0\.1:4322\/github\.com\/acme\/widgets/);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
