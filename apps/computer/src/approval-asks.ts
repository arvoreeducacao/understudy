import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
