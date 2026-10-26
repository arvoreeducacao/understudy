import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { featuredFor } from "@/lib/connector-showcase";
import { presetClientFor, withPresetClient } from "./connector-clients";

const SLACK = "https://mcp.slack.com/mcp";
const HUBSPOT = "https://mcp.hubspot.com/";
const saved = { SLACK_CONNECTOR_CLIENT_ID: process.env.SLACK_CONNECTOR_CLIENT_ID, SLACK_CONNECTOR_CLIENT_SECRET: process.env.SLACK_CONNECTOR_CLIENT_SECRET };

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function setSlackApp(clientId?: string, clientSecret?: string) {
  if (clientId === undefined) delete process.env.SLACK_CONNECTOR_CLIENT_ID;
  else process.env.SLACK_CONNECTOR_CLIENT_ID = clientId;
  if (clientSecret === undefined) delete process.env.SLACK_CONNECTOR_CLIENT_SECRET;
  else process.env.SLACK_CONNECTOR_CLIENT_SECRET = clientSecret;
}

test("with the server's Slack app, people sign in to Slack without pasting a client", () => {
  setSlackApp(" 111.222 ", " app-secret ");
  assert.deepEqual(presetClientFor(SLACK), { clientId: "111.222", clientSecret: "app-secret" });
  assert.deepEqual(withPresetClient(featuredFor(SLACK)!).signIn, { needsClient: false });
});

test("without both values the Slack connector still asks for its client", () => {
  setSlackApp("111.222");
  assert.equal(presetClientFor(SLACK), null);
  assert.deepEqual(withPresetClient(featuredFor(SLACK)!).signIn, { needsClient: true });
  setSlackApp(undefined, "app-secret");
  assert.equal(presetClientFor(SLACK), null);
});

test("the server's Slack app is never handed to another connector or a lookalike address", () => {
  setSlackApp("111.222", "app-secret");
  assert.equal(presetClientFor(HUBSPOT), null);
  assert.deepEqual(withPresetClient(featuredFor(HUBSPOT)!).signIn, { needsClient: true });
  assert.equal(presetClientFor("https://mcp.slack.com.example.dev/mcp"), null);
  assert.equal(presetClientFor("https://evil.example/mcp.slack.com/mcp"), null);
});
