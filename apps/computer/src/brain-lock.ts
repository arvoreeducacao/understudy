import { rmSync, statSync } from "node:fs";
import { join } from "node:path";

export type BrainLock = {
  run: <T>(task: () => Promise<T>) => Promise<T>;
  busy: () => boolean;
};

export function createBrainLock(): BrainLock {
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;
  return {
    run(task) {
      pending++;
      const result = tail.then(task).finally(() => {
        pending--;
      });
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    busy: () => pending > 0,
  };
}

const locks = new Map<string, BrainLock>();

export function brainLock(credentialsDir: string): BrainLock {
  let lock = locks.get(credentialsDir);
  if (!lock) {
    lock = createBrainLock();
    locks.set(credentialsDir, lock);
  }
  return lock;
}

export function claudeConfigDir(home: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(home, ".claude");
}

export const REFRESH_LOCK_NAME = ".oauth_refresh.lock";

export const STALE_REFRESH_LOCK_MS = 30 * 1000;

export function clearStaleRefreshLock(configDir: string, now = Date.now(), staleMs = STALE_REFRESH_LOCK_MS): boolean {
  const path = join(configDir, REFRESH_LOCK_NAME);
  try {
    if (now - statSync(path).mtimeMs < staleMs) return false;
    rmSync(path, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export const REFRESH_RETRY_DELAYS_MS = [15 * 1000, 30 * 1000, 60 * 1000, 120 * 1000];

export function isRefreshRace(error: string | undefined): boolean {
  return /another claude code process is refreshing|exited mid-refresh/i.test(error ?? "");
}

export function isSignedOut(error: string | undefined): boolean {
  if (isRefreshRace(error)) return false;
  return /not logged in|run \/login|login expired|oauth token (?:has expired|revoked)|invalid_grant|invalid authentication credentials/i.test(error ?? "");
}

export function signInAgainMessage(brain: string): string {
  const name = brain === "codex" ? "Codex" : "Claude";
  return `${name} is signed out on this computer. Open the agent's settings and connect ${name} again, then run it again.`;
}
