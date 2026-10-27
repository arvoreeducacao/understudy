import { BRAIN_BUDGET_MAX_USD } from "@understudy/protocol";
import type { BrainAccount } from "@/lib/db/schema";

export type BrainAccountView = { url: string | null; auth: BrainAccount["auth"]; last4: string; maxUsdPerTurn: number | null };

export type BrainAccountInput = { own: boolean; url?: string; auth?: string; key?: string; maxUsdPerTurn?: string | number | null };

export type BrainAccountProblem = "url" | "key" | "budget";

export function brainAccountView(account: BrainAccount | null | undefined): BrainAccountView | null {
  if (!account) return null;
  return { url: account.url, auth: account.auth, last4: account.last4, maxUsdPerTurn: account.maxUsdPerTurn };
}

function cleanUrl(value: string | undefined, allowHttp: boolean) {
  const raw = (value ?? "").trim();
  if (!raw) return { ok: true as const, url: null };
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) return { ok: false as const };
    if (url.username || url.password || url.search || url.hash) return { ok: false as const };
    return { ok: true as const, url: url.toString().replace(/\/+$/, "") };
  } catch {
    return { ok: false as const };
  }
}

function cleanBudget(value: string | number | null | undefined) {
  if (value === null || value === undefined || String(value).trim() === "") return { ok: true as const, budget: null };
  const amount = Number(String(value).replace(",", "."));
  if (!Number.isFinite(amount) || amount <= 0 || amount > BRAIN_BUDGET_MAX_USD) return { ok: false as const };
  return { ok: true as const, budget: Math.round(amount * 100) / 100 };
}

export function cleanBrainAccount(
  input: BrainAccountInput,
  previous: BrainAccount | null | undefined,
  seal: (plain: string) => string,
  allowHttp = false,
): { ok: true; account: BrainAccount | null } | { ok: false; problem: BrainAccountProblem } {
  if (!input.own) return { ok: true, account: null };
  const url = cleanUrl(input.url, allowHttp);
  if (!url.ok) return { ok: false, problem: "url" };
  const budget = cleanBudget(input.maxUsdPerTurn);
  if (!budget.ok) return { ok: false, problem: "budget" };
  const typed = (input.key ?? "").trim();
  if (typed && (typed.length < 8 || typed.length > 400 || /\s/.test(typed))) return { ok: false, problem: "key" };
  if (!typed && (!previous?.key || previous.url !== url.url)) return { ok: false, problem: "key" };
  return {
    ok: true,
    account: {
      url: url.url,
      auth: input.auth === "bearer" ? "bearer" : "x-api-key",
      key: typed ? seal(typed) : (previous?.key as string),
      last4: typed ? typed.slice(-4) : (previous?.last4 ?? ""),
      maxUsdPerTurn: budget.budget,
    },
  };
}
