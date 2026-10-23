import { isGoogleOnlyEmail } from "./env";

export type AccountState = { status: string; mustChangePassword: boolean; twoFactorEnabled: boolean; googleOnly: boolean };

export type AccountBlock = "pending" | "change-password" | "two-factor";

export function accountBlock(account: AccountState): AccountBlock | null {
  if (account.status !== "approved") return "pending";
  if (account.mustChangePassword && !account.googleOnly) return "change-password";
  if (!account.twoFactorEnabled && !account.googleOnly) return "two-factor";
  return null;
}

export function userBlock(u: { email: string; status: string; mustChangePassword: boolean; twoFactorEnabled: boolean }) {
  return accountBlock({ ...u, googleOnly: isGoogleOnlyEmail(u.email) });
}
