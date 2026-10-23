import type { WebSocket } from "ws";
import { and, asc, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { newId } from "@/lib/ids";
import { localeOr, messages as copy, messagesFor, type Messages } from "@/lib/messages";
import { agentTargets, isPass, ownerTargets, personTargets, relayGist, ROOM_LIMITS, roomPrompt, teamRoomPrompt, turnActive, wakeRefusal, type RoomMember } from "@/lib/rooms";
import type { Hub } from "../hub";
import { loadRoomMessages, sharedTeamRoom } from "../room-store";
import type { RoomEntry, RoomPresence, RoomToServer, ServerToRoom } from "../hub-types";
import { log, send } from "./shared";

type Participant = typeof schema.roomParticipants.$inferSelect;
type MessageRow = typeof schema.roomMessages.$inferSelect;

export function toRoomEntry(row: MessageRow): RoomEntry {
  return { id: row.id, author: row.author, agentId: row.agentId, ...(row.userId ? { userId: row.userId } : {}), ...(row.approvalId ? { approvalId: row.approvalId } : {}), ...(row.runId ? { runId: row.runId } : {}), text: row.text, at: row.createdAt.toISOString() };
}

export async function roomFor(roomId: string, userId: string) {
  const db = getDb();
  const [room] = await db.select().from(schema.rooms).where(eq(schema.rooms.id, roomId));
  if (!room) return null;
  if (!room.teamId) return room.ownerId === userId ? room : null;
  const [seat] = await db
    .select({ userId: schema.roomPeople.userId })
    .from(schema.roomPeople)
    .innerJoin(schema.teamMembers, and(eq(schema.teamMembers.teamId, room.teamId), eq(schema.teamMembers.userId, schema.roomPeople.userId)))
    .where(and(eq(schema.roomPeople.roomId, roomId), eq(schema.roomPeople.userId, userId)));
  return seat ? room : null;
}

export async function roomPeopleOf(roomId: string) {
  return getDb()
    .select({ id: schema.user.id, name: schema.user.name })
    .from(schema.roomPeople)
    .innerJoin(schema.user, eq(schema.user.id, schema.roomPeople.userId))
    .where(eq(schema.roomPeople.roomId, roomId))
    .orderBy(asc(schema.roomPeople.joinedAt));
}

export async function roomMembers(roomId: string): Promise<(RoomMember & Participant)[]> {
  const rows = await getDb()
    .select({ participant: schema.roomParticipants, name: schema.agents.name, role: schema.agents.role })
    .from(schema.roomParticipants)
    .innerJoin(schema.agents, eq(schema.agents.id, schema.roomParticipants.agentId))
    .where(eq(schema.roomParticipants.roomId, roomId))
    .orderBy(asc(schema.roomParticipants.joinedAt), asc(schema.agents.name));
  return rows.map((row) => ({ ...row.participant, id: row.participant.agentId, name: row.name, role: row.role }));
}

export class Rooms {
  private viewers = new Map<string, Set<WebSocket>>();
  private viewerUsers = new WeakMap<WebSocket, string>();
  private notes = new Map<string, string>();

  constructor(private hub: Hub) {}

  attachViewer(ws: WebSocket, roomId: string, userId: string) {
    const set = this.viewers.get(roomId) ?? new Set<WebSocket>();
    set.add(ws);
    this.viewers.set(roomId, set);
    this.viewerUsers.set(ws, userId);
    ws.on("message", (raw) => {
      let message: RoomToServer;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message?.type === "stop") {
        this.stop(roomId, userId).catch((error) => {
          log("room_stop_error", { roomId, error: String(error) });
          send(ws, { type: "error", message: copy.common.error } satisfies ServerToRoom);
        });
        return;
      }
      if (message?.type !== "chat") return;
      this.personSaid(roomId, userId, String(message.text ?? "")).catch((error) => {
        log("room_chat_error", { roomId, error: String(error) });
        send(ws, { type: "error", message: copy.common.error } satisfies ServerToRoom);
      });
    });
    ws.on("close", () => {
      set.delete(ws);
      if (set.size === 0) this.viewers.delete(roomId);
    });
    Promise.all([this.presenceAll(roomId), loadRoomMessages(roomId, 50)])
      .then(([participants, recent]) => send(ws, { type: "snapshot", participants, recent: recent.map(toRoomEntry) } satisfies ServerToRoom))
      .catch((error) => log("room_snapshot_error", { roomId, error: String(error) }));
  }

  closeViewers(roomId: string, userId?: string) {
    for (const ws of this.viewers.get(roomId) ?? []) if (!userId || this.viewerUsers.get(ws) === userId) ws.close(4003, "forbidden");
  }

  closeViewersOf(userId: string) {
    for (const set of this.viewers.values()) for (const ws of set) if (this.viewerUsers.get(ws) === userId) ws.close(4003, "forbidden");
  }

  broadcast(roomId: string, message: ServerToRoom) {
    const set = this.viewers.get(roomId);
    if (!set) return;
    const payload = JSON.stringify(message);
    for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(payload);
  }

  private presenceOf(roomId: string, participant: Participant): RoomPresence {
    const working = turnActive(participant.turnStartedAt);
    return {
      agentId: participant.agentId,
      working,
      note: working ? (this.notes.get(`${roomId}:${participant.agentId}`) ?? null) : null,
      online: this.hub.isOnline(participant.agentId),
    };
  }

  async presenceAll(roomId: string) {
    const rows = await getDb().select().from(schema.roomParticipants).where(eq(schema.roomParticipants.roomId, roomId));
    return rows.map((row) => this.presenceOf(roomId, row));
  }

  private async participant(roomId: string, agentId: string) {
    const [row] = await getDb()
      .select()
      .from(schema.roomParticipants)
      .where(and(eq(schema.roomParticipants.roomId, roomId), eq(schema.roomParticipants.agentId, agentId)));
    return row ?? null;
  }

  private async post(roomId: string, values: { author: MessageRow["author"]; agentId?: string; userId?: string; approvalId?: string; runId?: string; text: string; depth: number }) {
    const db = getDb();
    const [row] = await db
      .insert(schema.roomMessages)
      .values({ id: newId("rmsg"), roomId, author: values.author, agentId: values.agentId ?? null, userId: values.userId ?? null, approvalId: values.approvalId ?? null, runId: values.runId ?? null, text: values.text, depth: values.depth })
      .returning();
    await db.update(schema.rooms).set({ updatedAt: row.createdAt }).where(eq(schema.rooms.id, roomId));
    this.broadcast(roomId, { type: "message", entry: toRoomEntry(row) });
    return row;
  }

  async personSaid(roomId: string, userId: string, raw: string) {
    const text = raw.trim().slice(0, ROOM_LIMITS.textMax);
    if (!text) return;
    const room = await roomFor(roomId, userId);
    if (!room) return;
    await this.post(roomId, { author: room.teamId ? "person" : "owner", userId, text, depth: 0 });
    const members = await roomMembers(roomId);
    const targets = room.teamId ? personTargets(text, members) : ownerTargets(text, members);
    for (const agentId of targets) await this.wake(roomId, agentId, 1, room.teamId ? userId : null);
  }

  async wake(roomId: string, agentId: string, depth: number, askedBy: string | null = null) {
    const db = getDb();
    const current = await this.participant(roomId, agentId);
    if (!current) return;
    if (turnActive(current.turnStartedAt)) {
      await db
        .update(schema.roomParticipants)
        .set({ followUp: true, followUpAskedBy: askedBy })
        .where(and(eq(schema.roomParticipants.roomId, roomId), eq(schema.roomParticipants.agentId, agentId)));
      return;
    }
    const startedAt = new Date();
    await db
      .update(schema.roomParticipants)
      .set({ turnDepth: depth, turnStartedAt: startedAt, followUp: false, followUpAskedBy: null, askedBy })
      .where(and(eq(schema.roomParticipants.roomId, roomId), eq(schema.roomParticipants.agentId, agentId)));
    const prompt = await this.promptFor(roomId, agentId, askedBy);
    if (!prompt) return;
    this.notes.delete(`${roomId}:${agentId}`);
    const result = await this.hub.deliver(agentId, { type: "room_turn", roomId, prompt, ...(askedBy ? { askedBy } : {}) }, { source: "room" });
    if (result.status === "queued") this.notes.set(`${roomId}:${agentId}`, result.starting ? copy.rooms.starting : copy.rooms.reconnecting);
    this.broadcast(roomId, { type: "presence", participant: this.presenceOf(roomId, { ...current, turnDepth: depth, turnStartedAt: startedAt, followUp: false }) });
    log("room_turn", { roomId, agentId, depth, status: result.status });
  }

  private async promptFor(roomId: string, agentId: string, askedBy: string | null) {
    const db = getDb();
    const [room] = await db
      .select({ name: schema.rooms.name, owner: schema.user.name, teamId: schema.rooms.teamId, team: schema.teams.name })
      .from(schema.rooms)
      .innerJoin(schema.user, eq(schema.user.id, schema.rooms.ownerId))
      .leftJoin(schema.teams, eq(schema.teams.id, schema.rooms.teamId))
      .where(eq(schema.rooms.id, roomId));
    if (!room) return null;
    if (room.teamId) return this.teamPromptFor(roomId, agentId, room.name, room.team ?? "", askedBy);
    const members = await roomMembers(roomId);
    const self = members.find((member) => member.id === agentId);
    if (!self) return null;
    const recent = await db
      .select()
      .from(schema.roomMessages)
      .where(eq(schema.roomMessages.roomId, roomId))
      .orderBy(desc(schema.roomMessages.createdAt))
      .limit(ROOM_LIMITS.transcript);
    const names = new Map(members.map((member) => [member.id, member.name]));
    const lines = recent.reverse().map((row) => ({
      author: row.author,
      name: row.author === "owner" ? room.owner : row.author === "agent" ? (names.get(row.agentId ?? "") ?? copy.rooms.someoneWhoLeft) : "",
      text: row.text,
      at: row.createdAt.toISOString().slice(0, 16).replace("T", " "),
    }));
    const last = [...lines].reverse().find((line) => line.author !== "system" && line.name !== self.name);
    const addressedBy = !last ? room.owner : last.author === "owner" ? `your owner ${room.owner}` : `your teammate ${last.name}`;
    return roomPrompt({ room: room.name, owner: room.owner, self, members, lines, addressedBy });
  }

  private async teamPromptFor(roomId: string, agentId: string, roomName: string, team: string, askedBy: string | null) {
    const db = getDb();
    const [members, people] = await Promise.all([roomMembers(roomId), roomPeopleOf(roomId)]);
    const self = members.find((member) => member.id === agentId);
    if (!self) return null;
    const recent = await db
      .select({ author: schema.roomMessages.author, agentId: schema.roomMessages.agentId, userId: schema.roomMessages.userId, text: schema.roomMessages.text, createdAt: schema.roomMessages.createdAt, person: schema.user.name })
      .from(schema.roomMessages)
      .leftJoin(schema.user, eq(schema.user.id, schema.roomMessages.userId))
      .where(eq(schema.roomMessages.roomId, roomId))
      .orderBy(desc(schema.roomMessages.createdAt))
      .limit(ROOM_LIMITS.transcript);
    const names = new Map(members.map((member) => [member.id, member.name]));
    const lines = recent.reverse().map((row) => ({
      author: row.author,
      name: row.author === "agent" ? (names.get(row.agentId ?? "") ?? copy.rooms.someoneWhoLeft) : row.author === "system" ? "" : (row.person ?? copy.rooms.someoneWhoLeft),
      text: row.text,
      at: row.createdAt.toISOString().slice(0, 16).replace("T", " "),
    }));
    const asker = people.find((person) => person.id === askedBy)?.name ?? copy.rooms.someoneWhoLeft;
    const last = [...lines].reverse().find((line) => line.author !== "system" && line.name !== self.name);
    const addressedBy = !last ? asker : last.author === "agent" ? `the understudy ${last.name}` : last.name;
    return teamRoomPrompt({ room: roomName, team, self, members, people: people.map((person) => person.name), lines, addressedBy, askedBy: asker });
  }

  async agentSaid(agentId: string, roomId: string, raw: string) {
    const text = raw.trim().slice(0, 8000);
    const participant = await this.participant(roomId, agentId);
    if (!participant || !turnActive(participant.turnStartedAt)) {
      log("room_reply_dropped", { roomId, agentId });
      return;
    }
    if (!text || isPass(text)) return;
    const depth = participant.turnDepth ?? 1;
    await this.post(roomId, { author: "agent", agentId, text, depth });
    const members = await roomMembers(roomId);
    const targets = agentTargets(text, members, agentId);
    if (!targets.length) return;
    const ceiling = env.agentTalkCeiling;
    if (wakeRefusal({ depth: depth + 1, ceiling })) {
      await this.post(roomId, { author: "system", text: copy.rooms.stoppedCeiling(ceiling ?? 0), depth });
      log("room_wake_refused", { roomId, agentId, ceiling });
      return;
    }
    for (const target of targets) await this.wake(roomId, target, depth + 1, participant.askedBy);
  }

  async stop(roomId: string, userId: string) {
    const room = await roomFor(roomId, userId);
    if (!room) return false;
    const db = getDb();
    const halted = await db
      .update(schema.roomParticipants)
      .set({ turnStartedAt: null, followUp: false, followUpAskedBy: null })
      .where(and(eq(schema.roomParticipants.roomId, roomId), isNotNull(schema.roomParticipants.turnStartedAt)))
      .returning();
    await db.delete(schema.inboundQueue).where(and(eq(schema.inboundQueue.source, "room"), sql`${schema.inboundQueue.message}->>'roomId' = ${roomId}`));
    for (const participant of halted) {
      this.notes.delete(`${roomId}:${participant.agentId}`);
      this.broadcast(roomId, { type: "presence", participant: this.presenceOf(roomId, participant) });
    }
    const [person] = room.teamId ? await db.select({ name: schema.user.name }).from(schema.user).where(eq(schema.user.id, userId)) : [];
    await this.post(roomId, { author: "system", text: room.teamId ? copy.rooms.stoppedByPerson(person?.name ?? "") : copy.rooms.stoppedByOwner, depth: 0 });
    log("room_stopped", { roomId, halted: halted.length });
    return true;
  }

  async delta(agentId: string, roomId: string, streamId: string, text: string) {
    if (!this.viewers.has(roomId)) return;
    const participant = await this.participant(roomId, agentId);
    if (!participant || !turnActive(participant.turnStartedAt)) return;
    this.broadcast(roomId, { type: "delta", agentId, streamId, text });
  }

  async activity(agentId: string, roomId: string, text: string) {
    const participant = await this.participant(roomId, agentId);
    if (!participant || !turnActive(participant.turnStartedAt)) return;
    this.notes.set(`${roomId}:${agentId}`, text.slice(0, 200));
    this.broadcast(roomId, { type: "presence", participant: this.presenceOf(roomId, participant) });
  }

  async turnDone(agentId: string, roomId: string, ok: boolean, error?: string) {
    const db = getDb();
    const participant = await this.participant(roomId, agentId);
    if (!participant || !participant.turnStartedAt) return;
    await db
      .update(schema.roomParticipants)
      .set({ turnStartedAt: null, followUp: false, followUpAskedBy: null })
      .where(and(eq(schema.roomParticipants.roomId, roomId), eq(schema.roomParticipants.agentId, agentId)));
    this.notes.delete(`${roomId}:${agentId}`);
    const idle = { ...participant, turnStartedAt: null, followUp: false };
    this.broadcast(roomId, { type: "presence", participant: this.presenceOf(roomId, idle) });
    if (!ok) {
      const [agent] = await db.select({ name: schema.agents.name }).from(schema.agents).where(eq(schema.agents.id, agentId));
      await this.post(roomId, { author: "system", text: copy.rooms.couldNotAnswer(agent?.name ?? "", (error ?? "").slice(0, 300)), depth: participant.turnDepth ?? 0 });
      return;
    }
    if (participant.followUp) {
      const next = (participant.turnDepth ?? 1) + 1;
      if (!wakeRefusal({ depth: next, ceiling: env.agentTalkCeiling })) await this.wake(roomId, agentId, next, participant.followUpAskedBy);
    }
  }

  async expireStale(now = Date.now()) {
    const rows = await getDb().select().from(schema.roomParticipants).where(isNotNull(schema.roomParticipants.turnStartedAt));
    for (const row of rows) {
      if (!turnActive(row.turnStartedAt, now)) await this.turnDone(row.agentId, row.roomId, false, copy.rooms.timedOut);
    }
  }

  async teamworkRoom(fromId: string, toId: string, target?: string) {
    const current = this.hub.turnRoom(fromId);
    const roomId = target
      ? (await this.participant(target, fromId)) && (await this.participant(target, toId))
        ? target
        : null
      : current
        ? (await this.participant(current, toId))
          ? current
          : null
        : await sharedTeamRoom(fromId, toId);
    if (!roomId) return null;
    const [room] = await getDb()
      .select({ id: schema.rooms.id, name: schema.rooms.name, language: schema.teams.language })
      .from(schema.rooms)
      .innerJoin(schema.teams, eq(schema.teams.id, schema.rooms.teamId))
      .where(eq(schema.rooms.id, roomId));
    return room ? { id: room.id, name: room.name, locale: localeOr(room.language) } : null;
  }

  async relayTeamwork(fromId: string, toId: string, room: { id: string; locale: string }, text: (copy: Messages) => string, runId: string | null) {
    await this.post(room.id, { author: "agent", agentId: fromId, text: text(messagesFor(room.locale)), depth: 0, ...(runId ? { runId } : {}) });
    log("room_relay", { roomId: room.id, fromId, toId, runId });
    return room.id;
  }

  async relayRunClosed(agentId: string, runId: string, task: string, ok: boolean, summary: string) {
    const db = getDb();
    const [opening] = await db
      .select({ roomId: schema.roomMessages.roomId })
      .from(schema.roomMessages)
      .where(and(eq(schema.roomMessages.runId, runId), ne(schema.roomMessages.agentId, agentId)))
      .orderBy(asc(schema.roomMessages.createdAt))
      .limit(1);
    if (!opening || !(await this.participant(opening.roomId, agentId))) return;
    const [team] = await db.select({ language: schema.teams.language }).from(schema.rooms).innerJoin(schema.teams, eq(schema.teams.id, schema.rooms.teamId)).where(eq(schema.rooms.id, opening.roomId));
    const words = messagesFor(team?.language);
    const line = relayGist(summary, 280);
    await this.post(opening.roomId, { author: "agent", agentId, runId, text: ok ? words.rooms.relayDone(task, line) : words.rooms.relayFailed(task, line), depth: 0 });
  }

  async approvalRaised(agentId: string, roomId: string, approvalId: string, summary: string, askedBy: string) {
    const [row] = await getDb()
      .select({ participant: schema.roomParticipants })
      .from(schema.roomParticipants)
      .innerJoin(schema.rooms, eq(schema.rooms.id, schema.roomParticipants.roomId))
      .where(and(eq(schema.roomParticipants.roomId, roomId), eq(schema.roomParticipants.agentId, agentId), eq(schema.roomParticipants.askedBy, askedBy), isNotNull(schema.rooms.teamId)));
    if (!row || !turnActive(row.participant.turnStartedAt)) return;
    await this.post(roomId, { author: "system", agentId, userId: askedBy, approvalId, text: summary, depth: row.participant.turnDepth ?? 0 });
  }

  async approvalClosed(approvalId: string, status: string) {
    const rows = await getDb().select({ roomId: schema.roomMessages.roomId }).from(schema.roomMessages).where(eq(schema.roomMessages.approvalId, approvalId));
    for (const row of rows) this.broadcast(row.roomId, { type: "approval", approvalId, status });
  }

  async forAgentRooms(agentId: string) {
    const rows = await getDb().select({ roomId: schema.roomParticipants.roomId }).from(schema.roomParticipants).where(eq(schema.roomParticipants.agentId, agentId));
    return rows.map((row) => row.roomId);
  }

  async presenceChanged(agentId: string) {
    const roomIds = (await this.forAgentRooms(agentId)).filter((roomId) => this.viewers.has(roomId));
    if (!roomIds.length) return;
    const rows = await getDb()
      .select()
      .from(schema.roomParticipants)
      .where(and(eq(schema.roomParticipants.agentId, agentId), inArray(schema.roomParticipants.roomId, roomIds)));
    for (const row of rows) this.broadcast(row.roomId, { type: "presence", participant: this.presenceOf(row.roomId, row) });
  }
}
