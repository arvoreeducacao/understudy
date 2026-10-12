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
  grantedPolicy,
  isDestructive,
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

test("bulk controls reset each group to its default without touching the other group", () => {
  const custom = { search_threads: "never" as const, create_draft: "allow" as const, trash_message: "never" as const };
  assert.deepEqual(allowReadOnly(custom, [search, draft, trash]), { create_draft: "allow", trash_message: "never" });
  assert.deepEqual(askForRest(custom, [search, draft, trash]), { search_threads: "never" });
});

test("choices equal to the default are not stored, so a tool that loses its read-only hint asks again", () => {
  assert.deepEqual(withChoice({}, search, "allow"), {});
  assert.deepEqual(withChoice({}, draft, "allow"), { create_draft: "allow" });
  const stored = withChoice({}, search, "allow");
  const changed: ToolInfo = { name: "search_threads", annotations: { readOnlyHint: false } };
  assert.equal(effectivePermission({ serverId: "s", server: {}, tool: changed, policy: { s: stored } }).permission, "ask");
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
