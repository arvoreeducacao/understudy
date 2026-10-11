import assert from "node:assert/strict";
import { after, test } from "node:test";

process.env.DATABASE_URL = "postgres://nobody@127.0.0.1:1/none";
process.env.SLACK_BOT_TOKEN = "xoxb-fake-token";
process.env.BETTER_AUTH_SECRET ??= "test-secret";
process.env.UNDERSTUDY_PUBLIC_URL = "https://panel.example.com";

const calls: { method: string; body: Record<string, unknown> }[] = [];
let answer: (method: string, body: Record<string, unknown>) => Record<string, unknown> = () => ({ ok: true, ts: "1.1" });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!target.startsWith("https://slack.com/api/")) return realFetch(input, init);
  const method = new URL(target).pathname.split("/").pop() as string;
  const body = JSON.parse(String(init?.body ?? "{}"));
  calls.push({ method, body });
  return new Response(JSON.stringify(answer(method, body)));
}) as typeof fetch;

after(() => {
  globalThis.fetch = realFetch;
});

const { postAgentText } = await import("./slack-threads");

const KPI = "## Northwind\n**Open deals:** 12\n**Won:** 4";
const blockTypes = (body: Record<string, unknown>) => (body.blocks as { type: string }[]).map((block) => block.type);

test("a structured reply is posted as rich blocks", async () => {
  calls.length = 0;
  answer = () => ({ ok: true, ts: "1.1" });
  const result = await postAgentText({ channel: "C0FAKE", threadTs: "10.1", text: KPI });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(blockTypes(calls[0].body), ["header", "section"]);
  assert.equal(calls[0].body.thread_ts, "10.1");
});

test("when Slack refuses the blocks the same reply goes out as plain markdown", async () => {
  calls.length = 0;
  answer = (_, body) => (blockTypes(body).includes("header") ? { ok: false, error: "invalid_blocks" } : { ok: true, ts: "1.2" });
  const result = await postAgentText({ channel: "C0FAKE", text: KPI });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((call) => blockTypes(call.body)), [["header", "section"], ["markdown"]]);
  assert.equal((calls[1].body.blocks as { text: string }[])[0].text, KPI);
});

test("other failures are not retried", async () => {
  calls.length = 0;
  answer = () => ({ ok: false, error: "channel_not_found" });
  const result = await postAgentText({ channel: "C0FAKE", text: KPI });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 1);
});

test("chatty replies keep the single markdown block", async () => {
  calls.length = 0;
  answer = () => ({ ok: true, ts: "1.3" });
  await postAgentText({ channel: "C0FAKE", text: "Sure, I'll look into it." });
  assert.deepEqual(blockTypes(calls[0].body), ["markdown"]);
});
