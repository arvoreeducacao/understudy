import { z } from "zod";
import { normalizeRecipe } from "@understudy/protocol";
import type { schema } from "@/lib/db";
import { env } from "@/lib/env";
import { agentTabPath } from "@/lib/workspace-tabs";
import type { Hub } from "./hub";
import { isValidCron } from "./scheduler";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

type AgentRow = typeof schema.agents.$inferSelect;

export type TaskTool = {
  name: string;
  description: string;
  schema: z.ZodType;
  run: (args: never) => Promise<ToolResult>;
};

const reply = (text: string, isError = false): ToolResult => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

export function tasksLink(agentId: string) {
  return `${env.publicUrl}${agentTabPath(agentId, "tasks")}`;
}

export function taskLink(agentId: string, recipeId: string) {
  return `${env.publicUrl}/agents/${agentId}/recipes/${recipeId}`;
}

export function taskTools(hub: Pick<Hub, "recordings" | "proposals">, agent: Pick<AgentRow, "id">): TaskTool[] {
  return [
    {
      name: "save_task",
      description:
        "Save a routine as one of your tasks, so it shows up in your owner's Tasks tab and can run again on a schedule or on demand. This is the only way to create a task: notes or files in ~/memory are not tasks. Use it when your owner asks you to save, remember or keep a routine as a task; to suggest a task your owner did not ask for, use propose_task instead. description: the whole task in plain words, self-contained, because the task is written down later without this conversation: what it is for, the steps in order (sites, files, fields), the rules to follow, and when it should run. The task is created paused for your owner to review. Only say it is being saved if this tool accepted it, and never say it is already saved: the panel posts the link when it is ready, or the reason if it fails.",
      schema: z.object({ description: z.string().trim().min(10).max(20000) }),
      run: (async (args: { description: string }) => {
        const recordingId = await hub.recordings.startFromText(agent.id, args.description, "chat");
        if (!recordingId) return reply("not saved: your computer is not connected to the panel. Tell your owner the task was not saved.", true);
        return reply(
          `accepted: the task is being written down now and will appear paused in your owner's Tasks tab (${tasksLink(agent.id)}) for them to review and schedule. It is not saved yet; the panel will post the link to it when it is ready. Tell your owner exactly that, not that it is saved. [recordingId: ${recordingId}]`,
        );
      }) as TaskTool["run"],
    },
    {
      name: "propose_task",
      description:
        "Suggest saving something you just did as one of your tasks, when your owner did not ask you to. Use it after you finish a job for your owner in the chat that took several steps and could be needed again, or when the panel tells you your owner keeps asking for the same thing. Never use it for one-off questions, small talk, or work that is already one of your tasks. Your owner sees a card with this draft and saves it with one click or says not now; nothing is saved until they choose. Draft the task from what you actually did, self-contained and in plain words: title (short), why (one short line to your owner, for example that they asked for this three times this month), origin (repeated or multi_step), trigger (when it should run, in words), steps in order (sites, files, fields; mark ask_first on anything that sends, pays, submits, publishes or deletes), inputs (what it needs from your owner each time, if anything) and schedule (a 5-field cron like 0 9 * * 1-5 only when a regular time clearly fits, otherwise leave it out). After calling it, tell your owner in one short sentence that you suggested saving it as a task; do not repeat the steps. Propose each routine once.",
      schema: z.object({
        title: z.string().trim().min(3).max(200),
        why: z.string().trim().min(3).max(500),
        origin: z.enum(["repeated", "multi_step"]),
        trigger: z.string().trim().max(300).optional(),
        steps: z
          .array(z.object({ text: z.string().trim().min(1).max(1000), detail: z.string().trim().max(2000).optional(), ask_first: z.boolean().optional() }))
          .min(2)
          .max(30),
        inputs: z.array(z.object({ question: z.string().trim().min(1).max(1000), options: z.array(z.string().max(300)).max(10).optional() })).max(10).optional(),
        schedule: z.string().trim().max(100).optional(),
      }),
      run: (async (args: {
        title: string;
        why: string;
        origin: "repeated" | "multi_step";
        trigger?: string;
        steps: { text: string; detail?: string; ask_first?: boolean }[];
        inputs?: { question: string; options?: string[] }[];
        schedule?: string;
      }) => {
        const timezone = process.env.UNDERSTUDY_TIMEZONE?.trim() || "UTC";
        const cron = args.schedule && isValidCron(args.schedule, timezone) ? args.schedule : null;
        const recipe = normalizeRecipe(
          {
            title: args.title,
            trigger: args.trigger || (cron ? "on a schedule" : "when the owner asks"),
            steps: args.steps.map((step) => ({ text: step.text, detail: step.detail, mode: step.ask_first ? "ask" : "auto" })),
            questions: (args.inputs ?? []).map((input) => ({ text: input.question, options: input.options ?? [] })),
          },
          { requireSteps: true },
        );
        const result = await hub.proposals.propose(agent.id, { recipe, cron, timezone, reason: args.why, origin: args.origin });
        if (!result.ok) {
          if (result.reason === "exists") return reply(`not proposed: this is already your task "${result.recipeTitle}". Do not propose it again.`, true);
          if (result.reason === "dismissed") return reply(`not proposed: your owner chose not to save a task like this on ${result.at.toISOString().slice(0, 10)}. Do not propose it again or mention it.`, true);
          return reply("not proposed: your owner already has several suggestions waiting. Do not propose more until they answer.", true);
        }
        return reply(
          `${result.replaced ? "updated the suggestion already waiting" : "proposed"}: your owner sees a card to save "${recipe.title}" as a task${cron ? " on the suggested schedule" : ""}, or to say not now. It is not saved until they choose. Tell them in one short sentence, without repeating the steps. [proposalId: ${result.id}]`,
        );
      }) as TaskTool["run"],
    },
  ];
}
