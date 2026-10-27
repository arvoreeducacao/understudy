import assert from "node:assert/strict";
import { test } from "node:test";
import { brainAccount, brainAccountKey, brainAccountState, setBrainAccount, withBrainAccount } from "./brain-account.ts";
import { BUDGET_REACHED, claudeArgs, claudeResult } from "./brain.ts";

test("with a key of its own, the brain talks to the panel's model proxy and drops any provider key it had", () => {
  const env = { HOME: "/home/agent", ANTHROPIC_API_KEY: "old-key", ANTHROPIC_BASE_URL: "https://elsewhere.example.com" };
  const routed = withBrainAccount(env, "https://panel.example.com/", { token: "mdl_agt_1.sig" });
  assert.equal(routed.HOME, "/home/agent");
  assert.equal(routed.ANTHROPIC_API_KEY, undefined);
  assert.equal(routed.ANTHROPIC_BASE_URL, "https://panel.example.com/api/model");
  assert.equal(routed.ANTHROPIC_AUTH_TOKEN, "mdl_agt_1.sig");
  assert.equal(withBrainAccount(env, "https://panel.example.com", null), env);
});

test("the computer reports which key it holds without revealing it, and forgets it when told", () => {
  setBrainAccount({ token: "mdl_agt_1.sig", maxUsdPerTurn: 3 });
  assert.deepEqual(brainAccountState(), { key: brainAccountKey("mdl_agt_1.sig"), maxUsdPerTurn: 3 });
  assert.ok(!JSON.stringify(brainAccountState()).includes("sig"));
  setBrainAccount({ token: "" });
  assert.equal(brainAccount(), null);
  assert.equal(brainAccountState(), undefined);
});

test("a spending limit becomes the CLI's budget flag, and reaching it reads as a plain sentence", () => {
  const args = claudeArgs("{}", "sys", null, undefined, false, 2.5);
  assert.deepEqual(args.slice(args.indexOf("--max-budget-usd"), args.indexOf("--max-budget-usd") + 2), ["--max-budget-usd", "2.5"]);
  assert.ok(!claudeArgs("{}", "sys").includes("--max-budget-usd"));
  assert.ok(!claudeArgs("{}", "sys", null, undefined, false, 0).includes("--max-budget-usd"));
  assert.deepEqual(claudeResult(JSON.stringify({ type: "result", subtype: "error_max_budget_usd", is_error: true, session_id: "s1" })), { ok: false, text: BUDGET_REACHED, sessionId: "s1" });
  assert.deepEqual(claudeResult(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", session_id: "s1" })), { ok: true, text: "done", sessionId: "s1" });
});
