import { createHash } from "node:crypto";
import { PATHS, type BrainAccountState } from "@understudy/protocol";

export type BrainAccount = { token: string; maxUsdPerTurn?: number };

const PROVIDER_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"];

let current: BrainAccount | null = null;

export function setBrainAccount(account: BrainAccount | null) {
  current = account?.token ? account : null;
}

export function brainAccount() {
  return current;
}

export function brainAccountKey(token: string) {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

export function brainAccountState(account = current): BrainAccountState | undefined {
  if (!account) return undefined;
  return { key: brainAccountKey(account.token), ...(account.maxUsdPerTurn ? { maxUsdPerTurn: account.maxUsdPerTurn } : {}) };
}

export function withBrainAccount(env: NodeJS.ProcessEnv, serverUrl: string, account = current): NodeJS.ProcessEnv {
  if (!account) return env;
  const rest = Object.fromEntries(Object.entries(env).filter(([name]) => !PROVIDER_ENV.includes(name)));
  return { ...rest, ANTHROPIC_BASE_URL: `${serverUrl.replace(/\/+$/, "")}${PATHS.modelProxy}`, ANTHROPIC_AUTH_TOKEN: account.token };
}
