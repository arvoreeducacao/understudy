import assert from "node:assert/strict";
import { test } from "node:test";
import { askWords, coveredBy, isSimilarAsk, repeatedAsk, sameTask } from "./repetition";

const now = new Date("2026-03-20T09:00:00Z");
const daysAgo = (days: number, hours = 0) => new Date(now.getTime() - days * 86_400_000 - hours * 3_600_000);

test("words drop stopwords, numbers, links and accents", () => {
  assert.deepEqual([...askWords("Please check the Northwind invoices for 2026 at https://example.com/x")], ["northwind", "invoice"]);
  assert.deepEqual([...askWords("Relatório de vendas da Northwind")], ["relatorio", "venda", "northwind"]);
});

test("similar asks match even when worded a bit differently", () => {
  assert.ok(isSimilarAsk("Pull the open Northwind invoices into a spreadsheet", "Can you pull open Northwind invoices into the spreadsheet again?"));
  assert.ok(!isSimilarAsk("Pull the open Northwind invoices into a spreadsheet", "Book a meeting room for Friday afternoon with the design team"));
});

test("short messages never count as a repeated ask", () => {
  assert.equal(repeatedAsk("thanks!", [{ text: "thanks!", at: daysAgo(1) }, { text: "thanks!", at: daysAgo(2) }], now), null);
});

test("the third similar ask on separate occasions is a repeat", () => {
  const history = [
    { text: "Summarize the support inbox and list urgent tickets by customer", at: daysAgo(7) },
    { text: "Order lunch for the team", at: daysAgo(5) },
    { text: "summarize the support inbox, urgent tickets by customer please", at: daysAgo(3) },
  ];
  const hit = repeatedAsk("Can you summarize the support inbox with urgent tickets by customer?", history, now);
  assert.deepEqual(hit, { times: 3, since: daysAgo(7) });
});

test("asks a few minutes apart are one occasion", () => {
  const history = [
    { text: "Summarize the support inbox and list urgent tickets by customer", at: daysAgo(0, 0.2) },
    { text: "Summarize the support inbox and list urgent tickets by customer", at: daysAgo(0, 0.1) },
  ];
  assert.equal(repeatedAsk("Summarize the support inbox and list urgent tickets by customer", history, now), null);
});

test("asks older than the window do not count", () => {
  const history = [
    { text: "Export the weekly Northwind sales report to a spreadsheet", at: daysAgo(40) },
    { text: "Export the weekly Northwind sales report to a spreadsheet", at: daysAgo(35) },
  ];
  assert.equal(repeatedAsk("Export the weekly Northwind sales report to a spreadsheet", history, now), null);
});

const invoiceTask = {
  title: "Export open Northwind invoices",
  trigger: "every Monday morning",
  steps: [{ text: "Open the Northwind billing site" }, { text: "Filter open invoices" }, { text: "Export them to a spreadsheet" }],
};

test("an ask already covered by a task is recognized", () => {
  assert.ok(coveredBy("export the open Northwind invoices to a spreadsheet", [invoiceTask]));
  assert.ok(!coveredBy("book a meeting room for the design review", [invoiceTask]));
});

test("two drafts of the same routine are the same task", () => {
  assert.ok(sameTask(invoiceTask, { title: "Northwind open invoices export", trigger: "weekly", steps: [{ text: "Export open invoices" }] }));
  assert.ok(!sameTask(invoiceTask, { title: "Book the design review room", trigger: "when asked", steps: [{ text: "Open the room calendar" }] }));
});
