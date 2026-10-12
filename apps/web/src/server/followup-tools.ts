import { z } from "zod";
import type { Hub } from "./hub";
import { bookFollowup, cancelFollowup, FOLLOWUP_MAX_EMPTY_WAKES, FOLLOWUP_MAX_PENDING, FOLLOWUP_NOTE_MAX, followupTimezone, localTime, pendingFollowups } from "./followups";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export type FollowupTool = {
  name: string;
  description: string;
  schema: z.ZodType;
  run: (args: never) => Promise<ToolResult>;
};

const reply = (text: string, isError = false): ToolResult => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

export function followupTools(
  hub: Pick<Hub, "deliver" | "startRun" | "addMessage" | "notifyOwner">,
  agent: { id: string },
  context: { outsider: () => boolean; untrusted?: () => boolean; runId: () => Promise<string | null>; now?: () => Date },
): FollowupTool[] {
  const timeZone = followupTimezone();
  return [
    {
      name: "schedule_followup",
      description: `Book a time to pick something up again on your own, so you never have to promise "I'll check later" without a way to do it. At that time you are woken with your note: in this same conversation, or as a run of one of your tasks when you book it during that task's run or name a task. Use it when you are waiting on someone (a reply, a payment, an approval elsewhere), for a recurring check you agreed to do, when your owner says "remind me", and when your owner gives you a goal to keep (for example "keep the overdue list at zero"): check, act with approval, then book your next check. when: a delay like "2h", "30m", "1d", "1h 30m", or a time in your owner's time zone (${timeZone}) like "2026-03-02T09:00", or with an offset like "2026-03-02T09:00-03:00"; at least 10 minutes and at most 60 days ahead. note: what to do when you wake, self-contained, because you will not remember this moment (who or what you are waiting for, where to look, what to do if it arrived and what to do if it did not; for "wait for the reply and chase on Friday", book Friday and write both branches in the note). task: optional id or exact title of one of your tasks to run then instead of waking in the chat. progress: only when you book from a follow-up wake, say what changed or got done since that check; leave it out if nothing did. After ${FOLLOWUP_MAX_EMPTY_WAKES} checks in a row with nothing new the chain stops and your owner is told. At most ${FOLLOWUP_MAX_PENDING} follow-ups wait at once. After booking, always tell your owner in one short sentence when you will look again and why. Waking up never approves anything: irreversible steps still ask your owner first.`,
      schema: z.object({
        when: z.string().trim().min(1).max(100),
        note: z.string().trim().min(3).max(FOLLOWUP_NOTE_MAX),
        task: z.string().trim().max(200).optional(),
        progress: z.string().trim().max(500).optional(),
      }),
      run: (async (args: { when: string; note: string; task?: string; progress?: string }) => {
        const result = await bookFollowup(hub, agent, args, { runId: await context.runId(), outsider: context.outsider(), untrusted: context.untrusted?.() ?? false, now: context.now?.() });
        if (!result.ok) return reply(result.error, true);
        const where = result.taskTitle ? `as a run of your task "${result.taskTitle}"` : "in this conversation";
        return reply(
          `booked: you will be woken on ${localTime(result.followup.dueAt, timeZone)} ${where}, with your note. Your owner sees it under upcoming follow-ups and can cancel it. Tell them in one short sentence when you will look again and why. [followupId: ${result.followup.id}]`,
        );
      }) as FollowupTool["run"],
    },
    {
      name: "list_followups",
      description: "List the follow-ups you booked that have not happened yet, soonest first, with their id, time, note and task. Check it before booking, so you do not book the same check twice.",
      schema: z.object({}),
      run: (async () => {
        if (context.outsider()) return reply("not listed: you are answering someone who is not your owner", true);
        const rows = await pendingFollowups([agent.id], FOLLOWUP_MAX_PENDING);
        if (rows.length === 0) return reply("no follow-ups waiting");
        return reply(
          JSON.stringify(
            rows.map(({ followup, taskTitle }) => ({
              id: followup.id,
              when: localTime(followup.dueAt, timeZone),
              note: followup.note,
              ...(taskTitle ? { task: taskTitle } : {}),
            })),
          ),
        );
      }) as FollowupTool["run"],
    },
    {
      name: "cancel_followup",
      description: "Cancel a follow-up you booked, by its id from list_followups or from schedule_followup, when it is no longer needed (the reply arrived, your owner said stop, or you are replacing it with a better time). Tell your owner when you cancel one they knew about.",
      schema: z.object({ id: z.string().trim().min(1).max(200) }),
      run: (async (args: { id: string }) => {
        if (context.outsider()) return reply("not cancelled: you are answering someone who is not your owner", true);
        const cancelled = await cancelFollowup(agent.id, args.id, "agent");
        if (!cancelled) return reply(`not cancelled: no waiting follow-up has the id ${JSON.stringify(args.id)}; call list_followups to see them`, true);
        return reply(`cancelled the follow-up for ${localTime(cancelled.dueAt, timeZone)}`);
      }) as FollowupTool["run"],
    },
  ];
}
