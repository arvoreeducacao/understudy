import assert from "node:assert/strict";
import { test } from "node:test";
import { keyValue, richSlackMessage, toMrkdwn, validSlackMessage, type SlackBlock } from "./slack-blocks";
import { parseInline } from "@/lib/markdown";

const types = (blocks: SlackBlock[]) => blocks.map((block) => block.type);
const chartUrl = () => "https://panel.example.com/api/charts/abc.sig.png";

test("ordinary chat keeps the plain markdown path", () => {
  assert.equal(richSlackMessage("On it. I'll check the report and get back to you in a few minutes."), null);
  assert.equal(richSlackMessage("Done:\n- sent the invoice\n- updated the sheet\n\n[Open the sheet](https://sheets.example.com/1)"), null);
  assert.equal(richSlackMessage("## Plan\nFirst I read the inbox, then I reply."), null);
});

test("a KPI reply becomes a header and fields", () => {
  const message = richSlackMessage("## Northwind this week\n**Revenue:** $48,200\n**New customers:** 14\n**Churn:** 1.2%\n\n_Numbers from the billing export._");
  assert.ok(message);
  assert.deepEqual(types(message.blocks), ["header", "section", "context"]);
  assert.deepEqual(message.blocks[0], { type: "header", text: { type: "plain_text", text: "Northwind this week", emoji: true } });
  assert.deepEqual(message.blocks[1], {
    type: "section",
    fields: [
      { type: "mrkdwn", text: "*Revenue*\n$48,200" },
      { type: "mrkdwn", text: "*New customers*\n14" },
      { type: "mrkdwn", text: "*Churn*\n1.2%" },
    ],
  });
  assert.deepEqual(message.blocks[2], { type: "context", elements: [{ type: "mrkdwn", text: "Numbers from the billing export." }] });
  assert.match(message.text, /Revenue: \$48,200/);
});

test("a status list by person becomes fields after its intro line", () => {
  const message = richSlackMessage("Where everyone is:\n- **Maya:** reviewing the Q3 deck\n- **Ada:** out until Monday\n- **Leo:** ~~blocked~~ unblocked, shipping today");
  assert.ok(message);
  assert.deepEqual(types(message.blocks), ["markdown", "section"]);
  assert.equal((message.blocks[0] as { text: string }).text, "Where everyone is:");
  const fields = (message.blocks[1] as { fields: { text: string }[] }).fields.map((field) => field.text);
  assert.deepEqual(fields, ["*Maya*\nreviewing the Q3 deck", "*Ada*\nout until Monday", "*Leo*\n~blocked~ unblocked, shipping today"]);
});

test("more than ten pairs split into several sections", () => {
  const lines = Array.from({ length: 13 }, (_, i) => `**Region ${i + 1}:** ${i * 3}`).join("\n");
  const message = richSlackMessage(lines);
  assert.ok(message);
  assert.deepEqual(types(message.blocks), ["section", "section"]);
  assert.equal((message.blocks[1] as { fields: unknown[] }).fields.length, 3);
});

test("a table by person becomes one native table with numbers aligned right", () => {
  const message = richSlackMessage("Tickets closed:\n\n| Person | Closed | Note |\n|---|---|---|\n| Maya | 12 | [link](https://desk.example.com/m) |\n| Ada | 7 | |\n\nSource: help desk export");
  assert.ok(message);
  assert.deepEqual(types(message.blocks), ["markdown", "table", "context"]);
  const table = message.blocks[1] as { column_settings: unknown[]; rows: unknown[][] };
  assert.deepEqual(table.column_settings, [{ align: "left", is_wrapped: true }, { align: "right" }, { align: "left", is_wrapped: true }]);
  assert.deepEqual(table.rows[0], [{ type: "raw_text", text: "Person" }, { type: "raw_text", text: "Closed" }, { type: "raw_text", text: "Note" }]);
  assert.deepEqual(table.rows[1][2], { type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "link", url: "https://desk.example.com/m", text: "link" }] }] });
  assert.deepEqual(table.rows[2][2], { type: "raw_text", text: "–" });
});

test("only the first table is native and the second stays markdown", () => {
  const table = "| a | b |\n|---|---|\n| 1 | 2 |";
  const message = richSlackMessage(`${table}\n\n${table}`);
  assert.ok(message);
  assert.deepEqual(types(message.blocks), ["table", "markdown"]);
  assert.equal((message.blocks[1] as { text: string }).text, table);
});

const fencedReply = (lang: string) => `Hi Sam! Here is a test table\n\n\`\`\`${lang}\n| Item | Value |\n|------|-------|\n| Open orders | 1.204 |\n| Total orders | 3.518 |\n| Share open | 34,2% |\n\`\`\`\n(numbers from a sample export)`;

test("a pipe table inside a plain or markdown fence becomes a native table", () => {
  for (const lang of ["", "md", "markdown", "text", "MD"]) {
    const message = richSlackMessage(fencedReply(lang));
    assert.ok(message, `fence "${lang}"`);
    assert.deepEqual(types(message.blocks), ["markdown", "table", "markdown"]);
    assert.equal((message.blocks[2] as { text: string }).text, "(numbers from a sample export)");
    const table = message.blocks[1] as { rows: { text: string }[][] };
    assert.deepEqual(table.rows[0], [{ type: "raw_text", text: "Item" }, { type: "raw_text", text: "Value" }]);
    assert.deepEqual(table.rows[3], [{ type: "raw_text", text: "Share open" }, { type: "raw_text", text: "34,2%" }]);
    assert.doesNotMatch(message.text, /```/);
  }
});

test("a fence in another language or with more than a table stays a code block", () => {
  assert.equal(richSlackMessage(fencedReply("sql")), null);
  assert.equal(richSlackMessage("Output:\n\n```\nTotal rows: 3\n| a | b |\n|---|---|\n| 1 | 2 |\n```"), null);
  assert.equal(richSlackMessage("```\n| a | b |\n|---|---|\n| 1 | 2 |"), null);
});

test("an oversize table falls back to the plain path", () => {
  const rows = Array.from({ length: 120 }, (_, i) => `| Person ${i} | ${i} |`).join("\n");
  assert.equal(richSlackMessage(`| Person | Score |\n|---|---|\n${rows}`), null);
  const wide = `| ${"x".repeat(600)} | y |\n|---|---|\n${Array.from({ length: 20 }, () => `| ${"z".repeat(600)} | 1 |`).join("\n")}`;
  assert.equal(richSlackMessage(wide), null);
});

test("trailing links become url buttons", () => {
  const message = richSlackMessage("**Open:** 4\n**Closed:** 9\n\n[Open the board](https://board.example.com/x) · [Download CSV](https://files.example.com/a.csv)");
  assert.ok(message);
  assert.deepEqual(types(message.blocks), ["section", "actions"]);
  assert.deepEqual(message.blocks[1], {
    type: "actions",
    elements: [
      { type: "button", action_id: "link_0", text: { type: "plain_text", text: "Open the board", emoji: true }, url: "https://board.example.com/x" },
      { type: "button", action_id: "link_1", text: { type: "plain_text", text: "Download CSV", emoji: true }, url: "https://files.example.com/a.csv" },
    ],
  });
});

test("a chart fence becomes an image with a text version for notifications", () => {
  const source = '## Signups\n```chart\n{"type":"line","title":"Weekly signups","labels":["W1","W2","W3"],"series":[{"name":"Signups","values":[10,14,21]}]}\n```\n---\nUp 50% in three weeks.';
  const message = richSlackMessage(source, { chartUrl });
  assert.ok(message);
  assert.deepEqual(types(message.blocks), ["header", "image", "divider", "markdown"]);
  assert.deepEqual(message.blocks[1], { type: "image", image_url: chartUrl(), alt_text: "Weekly signups", title: { type: "plain_text", text: "Weekly signups" } });
  assert.match(message.text, /W1 10, W2 14, W3 21/);
  assert.doesNotMatch(message.text, /"series"/);
  const offline = richSlackMessage(source, { chartUrl: () => null });
  assert.ok(offline);
  assert.deepEqual(types(offline.blocks), ["header", "markdown", "divider", "markdown"]);
  assert.match((offline.blocks[1] as { text: string }).text, /^\*\*Weekly signups\*\*\nW1 10/);
});

test("a broken chart fence stays an ordinary code block", () => {
  assert.equal(richSlackMessage('```chart\n{"type":"pie"}\n```'), null);
});

test("more than fifty blocks gives up on rich blocks", () => {
  const source = Array.from({ length: 30 }, (_, i) => `## Team ${i}\n**Open:** ${i}\n**Done:** ${i * 2}`).join("\n\n");
  assert.equal(richSlackMessage(source), null);
});

test("inline markdown becomes Slack mrkdwn with mentions and links neutralized", () => {
  assert.equal(toMrkdwn(parseInline("**b** _i_ ~~s~~ `c` [t](https://example.com/a) <!channel> & co")), "*b* _i_ ~s~ `c` <https://example.com/a|t> &lt;!channel&gt; &amp; co");
});

test("label and value lines need a short value and a short label", () => {
  assert.ok(keyValue(parseInline("**Owner:** Maya")));
  assert.ok(keyValue(parseInline("Status: green")));
  assert.equal(keyValue(parseInline("I checked everything and here is what I found: nothing")), null);
  assert.equal(keyValue(parseInline(`Note: ${"long ".repeat(20)}`)), null);
  assert.equal(keyValue(parseInline("**Bold** text")), null);
});

test("the validator refuses blocks Slack would reject", () => {
  assert.equal(validSlackMessage([]), false);
  assert.equal(validSlackMessage([{ type: "header", text: { type: "plain_text", text: "x".repeat(151) } }]), false);
  assert.equal(validSlackMessage([{ type: "table", rows: [] }, { type: "table", rows: [] }]), false);
  assert.equal(validSlackMessage([{ type: "markdown", text: "x".repeat(12_001) }]), false);
  assert.equal(validSlackMessage([{ type: "divider" }]), true);
});
