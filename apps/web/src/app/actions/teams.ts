"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { getHub } from "@/server/hub-access";
import { addMember, bringAgent, createTeam, deleteTeam, releaseAgent, removeMember, setMemberRole, updateTeam } from "@/server/teams-store";

function teamAgents(teamId: string) {
  return getDb().select({ id: schema.agents.id, ownerId: schema.agents.ownerId, teamOwned: schema.agents.teamOwned }).from(schema.agents).where(eq(schema.agents.teamId, teamId));
}

async function agentRow(agentId: string) {
  const [agent] = await getDb().select({ ownerId: schema.agents.ownerId, teamId: schema.agents.teamId }).from(schema.agents).where(eq(schema.agents.id, agentId));
  return agent ?? null;
}

async function closeApprovals(agentId: string, userId: string, scope: { askedBy: string } | { exceptAskedBy: string }) {
  await getHub()?.cancelApprovals(agentId, userId, scope);
}

function refresh(teamId?: string) {
  revalidatePath("/", "layout");
  if (teamId) revalidatePath(`/teams/${teamId}`);
}

export async function openTeam(input: { name: string; description?: string }) {
  const user = await requireUser();
  const result = await createTeam(user.id, { name: input?.name, description: input?.description });
  if (result.ok) refresh(result.id);
  return result;
}

export async function editTeam(teamId: string, input: { name: string; description?: string }) {
  const user = await requireUser();
  const result = await updateTeam(String(teamId ?? ""), user.id, { name: input?.name, description: input?.description });
  if (result.ok) refresh(teamId);
  return result;
}

export async function removeTeam(teamId: string) {
  const user = await requireUser();
  const agents = await teamAgents(String(teamId ?? ""));
  const result = await deleteTeam(String(teamId ?? ""), user.id);
  if (result.ok) {
    for (const agent of agents) await closeApprovals(agent.id, user.id, { exceptAskedBy: agent.ownerId });
    refresh();
  }
  return result;
}

export async function inviteToTeam(teamId: string, input: { email: string; role: string }) {
  const user = await requireUser();
  const result = await addMember(String(teamId ?? ""), user.id, input?.email, input?.role);
  if (result.ok) refresh(teamId);
  return result;
}

export async function changeTeamRole(teamId: string, userId: string, role: string) {
  const user = await requireUser();
  const result = await setMemberRole(String(teamId ?? ""), user.id, String(userId ?? ""), role);
  if (result.ok) {
    getHub()?.closeViewers((_, viewer) => viewer.userId === userId);
    refresh(teamId);
  }
  return result;
}

export async function removeFromTeam(teamId: string, userId: string) {
  const user = await requireUser();
  const agents = await teamAgents(String(teamId ?? ""));
  const result = await removeMember(String(teamId ?? ""), user.id, String(userId ?? ""));
  if (result.ok) {
    for (const agent of agents) {
      const released = agent.ownerId === userId && !agent.teamOwned;
      await closeApprovals(agent.id, user.id, released ? { exceptAskedBy: userId } : { askedBy: String(userId ?? "") });
    }
    getHub()?.closeViewers((_, viewer) => viewer.userId === userId);
    getHub()?.rooms.closeViewersOf(String(userId ?? ""));
    refresh(teamId);
  }
  return result;
}

export async function bringToTeam(agentId: string, teamId: string, owned: boolean) {
  const user = await requireUser();
  const before = await agentRow(String(agentId ?? ""));
  const result = await bringAgent(String(agentId ?? ""), user.id, String(teamId ?? ""), Boolean(owned));
  if (result.ok) {
    if (before?.teamId && before.teamId !== teamId) await closeApprovals(agentId, user.id, { exceptAskedBy: before.ownerId });
    getHub()?.closeViewers((id, viewer) => id === agentId && viewer.userId !== user.id);
    refresh(teamId);
    revalidatePath(`/agents/${agentId}`);
  }
  return result;
}

export async function leaveTeamAgent(agentId: string) {
  const user = await requireUser();
  const before = await agentRow(String(agentId ?? ""));
  const result = await releaseAgent(String(agentId ?? ""), user.id);
  if (result.ok) {
    if (before) await closeApprovals(agentId, user.id, { exceptAskedBy: before.ownerId });
    getHub()?.closeViewers((id, viewer) => id === agentId && viewer.userId !== user.id);
    refresh();
    revalidatePath(`/agents/${agentId}`);
  }
  return result;
}
