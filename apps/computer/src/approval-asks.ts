import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { askOwnerOnce, listRunApprovals, type ApprovalRequest, type McpSession, type OwnerAnswer } from "./gatekeeper-client.ts";

export const ASK_MEMORY_MS = 26 * 60 * 60 * 1000;

export type AskSubject = { runId: string; stepId?: string; summary: string; fields: { label: string; value: string }[] };

type Entry = { requestId: string; at: number };

export function askStoreFile(home: string): string {
  return join(home, ".understudy", "approval-asks.json");
}

export function askKey(subject: AskSubject): string {
  return createHash("sha256")
    .update(JSON.stringify([subject.runId, subject.stepId ?? "", subject.summary, subject.fields.map((field) => [field.label, field.value])]))
    .digest("hex");
}

export function openAskStore(file: string, now: () => number = Date.now) {
  const read = (): Record<string, Entry> => {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (!parsed || typeof parsed !== "object") return {};
      return Object.fromEntries(
        Object.entries(parsed as Record<string, Entry>).filter(([, entry]) => typeof entry?.requestId === "string" && now() - Number(entry.at) < ASK_MEMORY_MS),
      );
    } catch {
      return {};
    }
  };
  const write = (entries: Record<string, Entry>) => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const scratch = `${file}.${process.pid}.tmp`;
    writeFileSync(scratch, JSON.stringify(entries), { mode: 0o600 });
    renameSync(scratch, file);
  };
  return {
    asked(subject: AskSubject): string | undefined {
      return read()[askKey(subject)]?.requestId;
    },
    remember(subject: AskSubject, requestId: string) {
      write({ ...read(), [askKey(subject)]: { requestId, at: now() } });
    },
    forget(subject: AskSubject) {
      const entries = read();
      const key = askKey(subject);
      if (!(key in entries)) return;
      delete entries[key];
      write(entries);
    },
  };
}

export type AskStore = ReturnType<typeof openAskStore>;

export function pendingText(summary: string, again: string | null, answer: Pick<OwnerAnswer, "text" | "requestId">): string {
  const why = /status\W{1,8}pending/i.test(answer.text) ? "" : ` (${answer.text.slice(0, 200)})`;
  const id = answer.requestId ? ` [requestId: ${answer.requestId}]` : "";
  if (!again) return `pending: your owner has not answered "${summary}" yet${why}, and that is not approval, so nothing was done. Tell your owner it waits for their answer, and try again once they have answered.${id}`;
  return `pending: your owner has not answered "${summary}" yet${why}, and that is not approval, so nothing was done. To keep waiting, ${again}: it does not ask your owner a second time. The run stays open until your owner answers, so do not end it or skip this item because of this.${id}`;
}

async function sameAsk(session: McpSession, request: ApprovalRequest & { runId: string }, requestId: string): Promise<boolean> {
  const listed = await listRunApprovals(session, request.runId, false);
  return [...listed.pending, ...listed.answered].some((ask) => ask.requestId === requestId && ask.summary === request.summary && (ask.stepId ?? undefined) === (request.stepId ?? undefined));
}

export async function askInRun(session: () => Promise<McpSession>, store: AskStore, request: ApprovalRequest & { runId: string }): Promise<OwnerAnswer> {
  const subject = { runId: request.runId, stepId: request.stepId, summary: request.summary, fields: request.fields };
  let known = store.asked(subject);
  try {
    const open = await session();
    if (known && !(await sameAsk(open, request, known))) {
      store.forget(subject);
      known = undefined;
    }
    const answer = await askOwnerOnce(open, request, known);
    if (answer.pending && answer.requestId) store.remember(subject, answer.requestId);
    else store.forget(subject);
    return answer;
  } catch (error) {
    return { approved: false, pending: true, text: `the panel could not be reached (${(error as Error).message}), so your owner's answer is not known yet`, ...(known ? { requestId: known } : {}) };
  }
}

export async function askOwnerFor(session: () => Promise<McpSession>, store: AskStore, request: ApprovalRequest): Promise<OwnerAnswer> {
  if (request.runId) return askInRun(session, store, { ...request, runId: request.runId });
  return askOwnerOnce(await session(), request);
}
