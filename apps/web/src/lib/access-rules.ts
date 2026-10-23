import type { TeamRole } from "./db/schema";

export type Access = "owner" | "admin" | "member" | "approver" | "viewer";

export function teamAccess(role: TeamRole | null | undefined, teamOwned: boolean): Access | null {
  if (!role) return null;
  return role === "admin" && teamOwned ? "admin" : "member";
}

export function canApprove(access: Access | null) {
  return access === "owner" || access === "admin" || access === "approver";
}

export function canChat(access: Access | null) {
  return access === "owner" || access === "admin" || access === "member";
}

export function canManage(access: Access | null) {
  return access === "owner" || access === "admin";
}

export function canAnswer(access: Access | null, askedBy: string | null, userId: string) {
  if (askedBy) return askedBy === userId && canChat(access);
  return canApprove(access);
}
