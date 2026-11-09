import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allowedHost,
  allowedTool,
  cleanApprovalPolicy,
  computerApprovalPolicy,
  DEFAULT_APPROVAL_POLICY,
  effectiveApprovalMode,
  listCoversActions,
  parseServerToComputer,
  siteListed,
  toolListed,
  withAllowed,
  withoutAllowed,
} from "./index.ts";

test("a missing or broken policy is today's behavior: ask what is not allowed, nothing allowed, wait", () => {
  assert.deepEqual(cleanApprovalPolicy(undefined), DEFAULT_APPROVAL_POLICY);
  assert.deepEqual(cleanApprovalPolicy({ mode: "yolo", fallback: "later", allow: "everything" }), { mode: "on-miss", allow: [], fallback: "wait" });
  assert.deepEqual(DEFAULT_APPROVAL_POLICY, { mode: "on-miss", allow: [], fallback: "wait" });
});

test("allowed sites are stored as bare host names and tools as gatekeeper names", () => {
  assert.equal(allowedHost("https://www.Example.com/path?q=1"), "example.com");
  assert.equal(allowedHost("shop.example.co.uk"), "shop.example.co.uk");
  assert.equal(allowedHost("not a host"), null);
  assert.equal(allowedHost(""), null);
  assert.equal(allowedTool("mcp__gatekeeper__Slack_Post_Message"), "slack_post_message");
  assert.equal(allowedTool("rm -rf /"), null);
  const policy = cleanApprovalPolicy({
    mode: "off",
    fallback: "deny",
    allow: [
      { kind: "host", value: "www.example.com" },
      { kind: "host", value: "example.com" },
      { kind: "tool", value: "slack_post_message" },
      { kind: "file", value: "/etc/passwd" },
      { kind: "host", value: "<script>" },
    ],
  });
  assert.deepEqual(policy, { mode: "off", fallback: "deny", allow: [{ kind: "host", value: "example.com" }, { kind: "tool", value: "slack_post_message" }] });
});

test("a listed site covers its subdomains, never a look-alike", () => {
  const hosts = ["example.com"];
  assert.equal(siteListed("example.com", hosts), true);
  assert.equal(siteListed("www.example.com", hosts), true);
  assert.equal(siteListed("api.example.com", hosts), true);
  assert.equal(siteListed("notexample.com", hosts), false);
  assert.equal(siteListed("example.com.evil.test", hosts), false);
  assert.equal(siteListed("", hosts), false);
});

test("adding and removing entries keeps the list clean and bounded", () => {
  let policy = withAllowed(DEFAULT_APPROVAL_POLICY, { kind: "host", value: "www.shop.test" });
  policy = withAllowed(policy, { kind: "host", value: "shop.test" });
  policy = withAllowed(policy, { kind: "tool", value: "slack_send_dm" });
  assert.deepEqual(policy.allow, [{ kind: "host", value: "shop.test" }, { kind: "tool", value: "slack_send_dm" }]);
  assert.equal(toolListed("mcp__gatekeeper__slack_send_dm", policy.allow), true);
  assert.equal(toolListed("slack_post_message", policy.allow), false);
  assert.deepEqual(withoutAllowed(policy, { kind: "host", value: "shop.test" }).allow, [{ kind: "tool", value: "slack_send_dm" }]);
  let full = DEFAULT_APPROVAL_POLICY;
  for (let index = 0; index < 205; index++) full = withAllowed(full, { kind: "host", value: `site${index}.test` });
  assert.equal(full.allow.length, 200);
  assert.equal(full.allow[0].value, "site5.test");
});

test("turns that are not the owner's never go below asking what is not allowed", () => {
  assert.equal(effectiveApprovalMode("off"), "off");
  assert.equal(effectiveApprovalMode("off", { untrusted: true }), "on-miss");
  assert.equal(effectiveApprovalMode("on-miss", { untrusted: true }), "on-miss");
  assert.equal(effectiveApprovalMode("always", { untrusted: true }), "always");
  assert.equal(effectiveApprovalMode("auto"), "on-miss");
  assert.equal(listCoversActions("on-miss"), true);
  assert.equal(listCoversActions("always"), false);
});

test("the computer gets the mode, the listed sites and who the owner is", () => {
  const policy = cleanApprovalPolicy({ mode: "always", allow: [{ kind: "host", value: "shop.test" }, { kind: "tool", value: "slack_send_dm" }] });
  const wire = computerApprovalPolicy(policy, "user_1");
  assert.deepEqual(wire, { mode: "always", hosts: ["shop.test"], ownerId: "user_1" });
  assert.equal(parseServerToComputer({ type: "set_approval_policy", policy: wire }).ok, true);
  assert.equal(parseServerToComputer({ type: "set_approval_policy", policy: { mode: "sometimes", hosts: [] } }).ok, false);
});
