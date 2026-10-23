"use server";

import { agentAccess } from "@/lib/access";
import { messages } from "@/lib/messages";
import { requireUser } from "@/lib/session";
import {
  activeShareLinks,
  artifactVisible,
  createShareLink,
  listArtifacts,
  loadArtifactView,
  revokeShareLinks,
  type ArtifactSummary,
  type ArtifactView,
  type ShareLink,
} from "@/server/artifacts/service";
import { ownAgent } from "./shared";

const ARTIFACT_ID = /^art_[A-Za-z0-9_-]{6,80}$/;

async function readable(agentId: string) {
  const user = await requireUser();
  if (!(await agentAccess(user.id, agentId))) throw new Error(messages.common.notFound);
  return user;
}

function checkId(artifactId: string) {
  if (typeof artifactId !== "string" || !ARTIFACT_ID.test(artifactId)) throw new Error(messages.common.notFound);
}

export async function agentArtifacts(agentId: string): Promise<ArtifactSummary[]> {
  const user = await readable(agentId);
  return listArtifacts(agentId, 200, user.id);
}

export async function artifactView(agentId: string, artifactId: string, version?: number): Promise<ArtifactView | null> {
  const user = await readable(agentId);
  checkId(artifactId);
  if (!(await artifactVisible(agentId, artifactId, user.id))) return null;
  return loadArtifactView(agentId, artifactId, Number.isInteger(version) ? version : undefined);
}

export async function artifactLinks(agentId: string, artifactId: string) {
  const { user } = await ownAgent(agentId);
  checkId(artifactId);
  if (!(await artifactVisible(agentId, artifactId, user.id))) return [];
  return activeShareLinks(agentId, artifactId);
}

export async function shareArtifact(agentId: string, artifactId: string, version: number): Promise<ShareLink> {
  const { user } = await ownAgent(agentId);
  checkId(artifactId);
  if (!Number.isInteger(version) || version < 1 || !(await artifactVisible(agentId, artifactId, user.id))) throw new Error(messages.common.notFound);
  const link = await createShareLink(agentId, artifactId, version, user.id);
  if (!link) throw new Error(messages.common.notFound);
  return link;
}

export async function unshareArtifact(agentId: string, artifactId: string) {
  const { user } = await ownAgent(agentId);
  checkId(artifactId);
  if (!(await artifactVisible(agentId, artifactId, user.id))) throw new Error(messages.common.notFound);
  return revokeShareLinks(agentId, artifactId);
}
