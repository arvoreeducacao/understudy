import assert from "node:assert/strict";
import { test } from "node:test";
import { ceilingForAgent, isSlackProfile, slackProfileMode } from "./slack-profile";
import { canAlwaysAllow, effectivePermission, type ConnectorCeiling } from "./tool-policy";

const SLACK = "https://mcp.slack.com/mcp";
const ceiling: ConnectorCeiling = { askAll: false, askTools: [], neverTools: [], askWrites: true };
const send = { name: "slack_send_message", annotations: { readOnlyHint: false } };
const read = { name: "slack_read_channel", annotations: { readOnlyHint: true } };

test("posting as the owner keeps asking unless the owner chose to let it post on its own", () => {
  assert.equal(slackProfileMode(undefined), "ask");
  assert.equal(slackProfileMode({ slackProfileMode: "ask" }), "ask");
  assert.equal(slackProfileMode({ slackProfileMode: "free" }), "free");
  assert.deepEqual(ceilingForAgent(ceiling, SLACK, {}), ceiling);
  assert.deepEqual(ceilingForAgent(ceiling, SLACK, { slackProfileMode: "ask" }), ceiling);
  assert.equal(ceilingForAgent(ceiling, SLACK, { slackProfileMode: "free" }).askWrites, false);
});

test("letting it post on its own runs the sends the owner allowed and leaves every other limit in place", () => {
  const policy = { slack: { slack_send_message: "allow" as const } };
  const asked = effectivePermission({ serverId: "slack", server: ceilingForAgent(ceiling, SLACK, { slackProfileMode: "ask" }), tool: send, policy });
  const free = effectivePermission({ serverId: "slack", server: ceilingForAgent(ceiling, SLACK, { slackProfileMode: "free" }), tool: send, policy });
  assert.equal(asked.permission, "ask");
  assert.equal(free.permission, "allow");
  assert.equal(effectivePermission({ serverId: "slack", server: ceilingForAgent(ceiling, SLACK, { slackProfileMode: "free" }), tool: send }).permission, "ask");
  const adminAsks = ceilingForAgent({ ...ceiling, askTools: ["slack_send_message"] }, SLACK, { slackProfileMode: "free" });
  assert.equal(effectivePermission({ serverId: "slack", server: adminAsks, tool: send, policy }).permission, "ask");
  assert.equal(effectivePermission({ serverId: "slack", server: ceilingForAgent({ ...ceiling, askAll: true }, SLACK, { slackProfileMode: "free" }), tool: send, policy }).permission, "ask");
  assert.equal(canAlwaysAllow(ceilingForAgent(ceiling, SLACK, { slackProfileMode: "ask" }), send.name, send.annotations), false);
  assert.equal(effectivePermission({ serverId: "slack", server: ceilingForAgent(ceiling, SLACK, { slackProfileMode: "ask" }), tool: read }).permission, "allow");
});

test("only the Slack connector can be let loose, never another connector that acts as the person", () => {
  assert.equal(isSlackProfile(SLACK), true);
  assert.equal(isSlackProfile("https://mcp.slack.com.example.dev/mcp"), false);
  assert.equal(ceilingForAgent(ceiling, "https://gmailmcp.googleapis.com/mcp/v1", { slackProfileMode: "free" }).askWrites, true);
});
