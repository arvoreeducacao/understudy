import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allowReadOnly,
  allowedChoices,
  askForRest,
  canAlwaysAllow,
  ceilingFor,
  cleanPolicy,
  cleanToolNames,
  defaultPermission,
  effectivePermission,
  cleanSeenHints,
  grantedPolicy,
  hintsLoosened,
  isDestructive,
  recordedHints,
  oneLine,
  withChoice,
  withLegacyAsks,
  type ToolInfo,
} from "./tool-policy";

const search: ToolInfo = { name: "search_threads", annotations: { readOnlyHint: true } };
const draft: ToolInfo = { name: "create_draft", annotations: { readOnlyHint: false, destructiveHint: false } };
const trash: ToolInfo = { name: "trash_message", annotations: { destructiveHint: true } };
const bare: ToolInfo = { name: "do_something" };

test("read-only tools are allowed by default and everything else asks", () => {
  assert.equal(defaultPermission(search.annotations), "allow");
  assert.equal(defaultPermission(draft.annotations), "ask");
  assert.equal(defaultPermission(trash.annotations), "ask");
  assert.equal(defaultPermission(bare.annotations), "ask");
});

test("a tool that claims to be both read-only and destructive is not trusted as read-only", () => {
  const odd = { readOnlyHint: true, destructiveHint: true };
  assert.equal(defaultPermission(odd), "ask");
  assert.equal(isDestructive(odd), true);
});

test("only tools explicitly marked destructive are flagged", () => {
  assert.equal(isDestructive(trash.annotations), true);
  assert.equal(isDestructive(draft.annotations), false);
  assert.equal(isDestructive(bare.annotations), false);
  assert.equal(isDestructive(search.annotations), false);
});

test("the admin ceiling is never loosened by the owner", () => {
  const server = { askAll: false, askTools: ["search_threads"], neverTools: ["trash_message"] };
  const policy = { mcp_mail: { search_threads: "allow" as const, trash_message: "allow" as const, create_draft: "allow" as const } };
  assert.deepEqual(effectivePermission({ serverId: "mcp_mail", server, tool: search, policy }), { permission: "ask", source: "admin" });
  assert.deepEqual(effectivePermission({ serverId: "mcp_mail", server, tool: trash, policy }), { permission: "never", source: "admin" });
  assert.deepEqual(effectivePermission({ serverId: "mcp_mail", server, tool: draft, policy }), { permission: "allow", source: "owner" });
});

test("ask-all on the connector caps every tool at ask", () => {
  const server = { askAll: true };
  assert.equal(ceilingFor(server, "anything"), "ask");
  assert.equal(effectivePermission({ serverId: "s", server, tool: search }).permission, "ask");
  assert.equal(effectivePermission({ serverId: "s", server, tool: search, policy: { s: { search_threads: "never" } } }).permission, "never");
  assert.equal(canAlwaysAllow(server, "search_threads"), false);
});

test("owners can always be stricter than the ceiling", () => {
  assert.deepEqual(allowedChoices("allow"), ["allow", "ask", "never"]);
  assert.deepEqual(allowedChoices("ask"), ["ask", "never"]);
  assert.deepEqual(allowedChoices("never"), ["never"]);
});

test("a tool that is new on the server gets the default even after bulk choices", () => {
  const before = allowReadOnly({}, [search, draft]);
  const fresh: ToolInfo = { name: "send_message" };
  assert.equal(effectivePermission({ serverId: "s", server: {}, tool: fresh, policy: { s: before } }).permission, "ask");
});

test("an older ask-first choice still counts as ask", () => {
  const result = effectivePermission({ serverId: "s", server: {}, tool: search, legacyAsk: ["s:search_threads"] });
  assert.deepEqual(result, { permission: "ask", source: "owner" });
});

test("bulk controls set each group explicitly without touching the other group", () => {
  const custom = { search_threads: "never" as const, create_draft: "allow" as const, trash_message: "never" as const };
  assert.deepEqual(allowReadOnly(custom, [search, draft, trash]), { search_threads: "allow", create_draft: "allow", trash_message: "never" });
  assert.deepEqual(askForRest(custom, [search, draft, trash]), { search_threads: "never", create_draft: "ask", trash_message: "ask" });
});

test("an explicit ask is stored even when it equals the default", () => {
  assert.deepEqual(withChoice({}, draft, "ask"), { create_draft: "ask" });
  assert.deepEqual(withChoice({}, search, "allow"), { search_threads: "allow" });
});

test("an owner's ask survives the connector later claiming the tool is read-only", () => {
  const stored = withChoice({}, draft, "ask");
  const relabeled: ToolInfo = { name: "create_draft", annotations: { readOnlyHint: true } };
  assert.deepEqual(effectivePermission({ serverId: "s", server: {}, tool: relabeled, policy: { s: stored } }), { permission: "ask", source: "owner" });
});

test("a tool whose hints became less safe since they were recorded falls back to ask", () => {
  const seen = { s: { create_draft: { readOnlyHint: false }, purge_all: { destructiveHint: true }, plain: {} } };
  const relabeled: ToolInfo = { name: "create_draft", annotations: { readOnlyHint: true } };
  const purge: ToolInfo = { name: "purge_all", annotations: { readOnlyHint: true, destructiveHint: false } };
  const plain: ToolInfo = { name: "plain", annotations: { readOnlyHint: true } };
  for (const tool of [relabeled, purge, plain]) {
    assert.equal(hintsLoosened(seen.s[tool.name as keyof typeof seen.s], tool.annotations), true, tool.name);
    assert.deepEqual(effectivePermission({ serverId: "s", server: {}, tool, seen }), { permission: "ask", source: "default" }, tool.name);
  }
  assert.equal(effectivePermission({ serverId: "s", server: {}, tool: search, seen: { s: { search_threads: { readOnlyHint: true } } } }).permission, "allow");
  assert.equal(effectivePermission({ serverId: "s", server: {}, tool: draft, seen: { s: { create_draft: { readOnlyHint: true } } } }).permission, "ask");
  assert.equal(effectivePermission({ serverId: "s", server: {}, tool: search }).permission, "allow");
});

test("recorded hints keep the first ones seen until the owner makes a choice", () => {
  const seen = { s: { create_draft: { readOnlyHint: false } } };
  const relabeled: ToolInfo = { name: "create_draft", annotations: { readOnlyHint: true } };
  assert.deepEqual(recordedHints(seen, "s", [relabeled, search]), { create_draft: { readOnlyHint: false, destructiveHint: false }, search_threads: { readOnlyHint: true } });
  assert.deepEqual(recordedHints(seen, "s", [relabeled], { create_draft: "allow" }), { create_draft: { readOnlyHint: true } });
});

test("stored hints keep only enabled servers and boolean hints", () => {
  const input = { s: { a: { readOnlyHint: true, extra: 1 }, b: { readOnlyHint: "yes" }, c: "x", "": {} }, t: { d: {} } };
  assert.deepEqual(cleanSeenHints(input, ["s"]), { s: { a: { readOnlyHint: true }, b: {} } });
  assert.deepEqual(cleanSeenHints([1], ["s"]), {});
});

test("tool names are compared without regard to case or compatible forms", () => {
  const server = { neverTools: ["delete_repo"], askTools: ["Send_Mail"] };
  assert.equal(ceilingFor(server, "Delete_Repo"), "never");
  assert.equal(ceilingFor(server, "DELETE_REPO "), "never");
  assert.equal(ceilingFor(server, "ｄｅｌｅｔｅ_ｒｅｐｏ"), "never");
  assert.equal(ceilingFor(server, "send_mail"), "ask");
  assert.equal(canAlwaysAllow(server, "Delete_Repo"), false);
  assert.equal(canAlwaysAllow(server, "SEND_MAIL"), false);
  const loud: ToolInfo = { name: "Delete_Repo", annotations: { readOnlyHint: true } };
  assert.deepEqual(effectivePermission({ serverId: "s", server, tool: loud, policy: { s: { Delete_Repo: "allow" } } }), { permission: "never", source: "admin" });
  assert.equal(effectivePermission({ serverId: "s", server: {}, tool: loud, policy: { s: { delete_repo: "never", DELETE_REPO: "allow" } } }).permission, "never");
  assert.equal(effectivePermission({ serverId: "s", server: {}, tool: loud, legacyAsk: ["s:delete_repo"] }).permission, "ask");
});

test("stored policy keeps only enabled servers and known permissions", () => {
  const input = { mcp_a: { one: "allow", two: "maybe", "": "ask" }, mcp_b: { three: "never" }, mcp_c: "allow" };
  assert.deepEqual(cleanPolicy(input, ["mcp_a", "mcp_c"]), { mcp_a: { one: "allow" } });
  assert.deepEqual(cleanPolicy(null, ["mcp_a"]), {});
  assert.deepEqual(cleanPolicy([1, 2], ["mcp_a"]), {});
});

test("tool name lists are deduplicated and bounded", () => {
  assert.deepEqual(cleanToolNames(["a", "a", "", "b", "x".repeat(201)]), ["a", "b"]);
  assert.deepEqual(cleanToolNames("a"), []);
});

test("granting a tool keeps the rest of the policy", () => {
  assert.deepEqual(grantedPolicy({ s: { a: "never" }, t: { b: "ask" } }, "s", "c"), { s: { a: "never", c: "allow" }, t: { b: "ask" } });
  assert.deepEqual(grantedPolicy(undefined, "s", "c"), { s: { c: "allow" } });
});

test("descriptions are shown on one bounded line", () => {
  assert.equal(oneLine("Creates a draft\n\n  in the mailbox"), "Creates a draft in the mailbox");
  assert.equal(oneLine("x".repeat(400), 10).length, 10);
  assert.equal(oneLine(undefined), "");
});

test("older ask-first choices become explicit asks without overriding newer choices", () => {
  assert.deepEqual(withLegacyAsks({ s: { a: "never" } }, ["s:a", "s:b", "t:c:d", "broken", ":x"]), { s: { a: "never", b: "ask" }, t: { "c:d": "ask" } });
  assert.deepEqual(withLegacyAsks(undefined, undefined), {});
});
