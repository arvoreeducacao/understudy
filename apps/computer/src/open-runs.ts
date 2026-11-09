import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type OpenRun<Job> = { job: Job; sessionId: string | null; model?: string; at: number };

export function openRunsFile(home: string): string {
  return join(home, ".understudy", "open-runs.json");
}

export function openRunStore<Job>(file: string, now: () => number = Date.now) {
  const read = (): Record<string, OpenRun<Job>> => {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      return parsed && typeof parsed === "object" ? (parsed as Record<string, OpenRun<Job>>) : {};
    } catch {
      return {};
    }
  };
  const write = (runs: Record<string, OpenRun<Job>>) => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const scratch = `${file}.${process.pid}.tmp`;
    writeFileSync(scratch, JSON.stringify(runs), { mode: 0o600 });
    renameSync(scratch, file);
  };
  return {
    list(): (OpenRun<Job> & { runId: string })[] {
      return Object.entries(read())
        .filter(([, run]) => run && typeof run === "object" && run.job)
        .map(([runId, run]) => ({ ...run, runId }));
    },
    save(runId: string, run: Omit<OpenRun<Job>, "at">) {
      write({ ...read(), [runId]: { ...run, at: now() } });
    },
    update(runId: string, change: Partial<Omit<OpenRun<Job>, "job" | "at">>) {
      const runs = read();
      if (!runs[runId]) return;
      runs[runId] = { ...runs[runId], ...change };
      write(runs);
    },
    drop(runId: string) {
      const runs = read();
      if (!(runId in runs)) return;
      delete runs[runId];
      write(runs);
    },
  };
}
