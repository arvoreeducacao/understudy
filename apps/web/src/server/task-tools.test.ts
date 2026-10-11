import assert from "node:assert/strict";
import { test } from "node:test";
import { taskTools } from "./task-tools";

const saveTask = () => taskTools({ recordings: {} } as never, { id: "agt_x" }).find((tool) => tool.name === "save_task")!;

test("save_task tells the brain that memory notes are not tasks and that it must not claim a task is already saved", () => {
  const tool = saveTask();
  assert.match(tool.description, /notes or files in ~\/memory are not tasks/);
  assert.match(tool.description, /never say it is already saved/);
  assert.match(tool.description, /paused/);
});

test("save_task refuses an empty description", () => {
  const tool = saveTask();
  assert.equal(tool.schema.safeParse({ description: "   " }).success, false);
  assert.equal(tool.schema.safeParse({}).success, false);
  assert.equal(tool.schema.safeParse({ description: "Download the weekly sales report" }).success, true);
});

type Proposed = { recipe: { title: string; steps: { text: string; mode: string }[]; questions: { text: string }[] }; cron: string | null; reason: string; origin: string };

function proposeTask(answer: (input: Proposed) => unknown) {
  const calls: Proposed[] = [];
  const hub = { recordings: {}, proposals: { propose: async (_agentId: string, input: Proposed) => (calls.push(input), answer(input)) } };
  const tool = taskTools(hub as never, { id: "agt_x" }).find((t) => t.name === "propose_task")!;
  return { tool, calls, run: (args: unknown) => (tool.run as unknown as (a: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>)(tool.schema.parse(args)) };
}

const draft = {
  title: "Weekly Northwind invoice export",
  why: "You asked me for this three times this month.",
  origin: "repeated",
  steps: [{ text: "Open the Northwind billing site and filter open invoices" }, { text: "Mark the exported invoices as reviewed", ask_first: true }, { text: "Send the spreadsheet to finance" }],
  inputs: [{ question: "Which month?" }],
  schedule: "0 9 * * 1",
};

test("propose_task needs at least two steps and a known origin", () => {
  const { tool } = proposeTask(() => ({ ok: true, id: "prp_1", replaced: false }));
  assert.equal(tool.schema.safeParse({ ...draft, steps: [draft.steps[0]] }).success, false);
  assert.equal(tool.schema.safeParse({ ...draft, origin: "because" }).success, false);
  assert.equal(tool.schema.safeParse(draft).success, true);
});

test("propose_task drafts a recipe with risky steps asking first and keeps a valid schedule", async () => {
  const { calls, run } = proposeTask(() => ({ ok: true, id: "prp_1", replaced: false }));
  const result = await run(draft);
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /^proposed: .*not saved until they choose/);
  assert.equal(calls[0].cron, "0 9 * * 1");
  assert.equal(calls[0].origin, "repeated");
  assert.deepEqual(calls[0].recipe.steps.map((step) => step.mode), ["auto", "ask", "ask"]);
  assert.deepEqual(calls[0].recipe.questions.map((q) => q.text), ["Which month?"]);
});

test("propose_task drops a schedule that is not a valid cron", async () => {
  const { calls, run } = proposeTask(() => ({ ok: true, id: "prp_1", replaced: false }));
  await run({ ...draft, schedule: "every monday" });
  assert.equal(calls[0].cron, null);
});

test("propose_task tells the brain not to insist after the owner said not now", async () => {
  const { run } = proposeTask(() => ({ ok: false, reason: "dismissed", at: new Date("2026-03-01T00:00:00Z") }));
  const result = await run(draft);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /chose not to save .* 2026-03-01\. Do not propose it again/);
});
