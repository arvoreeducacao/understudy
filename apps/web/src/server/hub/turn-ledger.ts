import type { ServerToComputer } from "@understudy/protocol";

export type TurnContext = { audience: string | null; roomId: string | null };

type Expected = { askedBy: string | null; roomId: string | null };

const MAX_EXPECTED = 100;

export class TurnLedger {
  private expected = new Map<string, Expected[]>();
  private current = new Map<string, TurnContext>();

  delivered(agentId: string, message: ServerToComputer) {
    const entry: Expected | null =
      message.type === "chat" && message.askedBy
        ? { askedBy: message.askedBy, roomId: null }
        : message.type === "room_turn"
          ? { askedBy: message.askedBy ?? null, roomId: message.roomId }
          : null;
    if (!entry) return;
    const list = this.expected.get(agentId) ?? [];
    list.push(entry);
    if (list.length > MAX_EXPECTED) list.splice(0, list.length - MAX_EXPECTED);
    this.expected.set(agentId, list);
  }

  started(agentId: string, turn: { askedBy?: string; roomId?: string; runId?: string }): TurnContext & { matched: boolean } {
    if (turn.runId || (!turn.askedBy && !turn.roomId)) return this.set(agentId, { audience: null, roomId: null }, true);
    const list = this.expected.get(agentId) ?? [];
    const index = list.findIndex((entry) => (turn.roomId ? entry.roomId === turn.roomId : entry.roomId === null) && entry.askedBy === (turn.askedBy ?? null));
    if (index < 0) return this.set(agentId, { audience: null, roomId: null }, false);
    const [entry] = list.splice(index, 1);
    return this.set(agentId, { audience: entry.askedBy, roomId: entry.roomId }, true);
  }

  set(agentId: string, context: TurnContext, matched = true) {
    if (context.audience || context.roomId) this.current.set(agentId, context);
    else this.current.delete(agentId);
    return { ...context, matched };
  }

  audience(agentId: string) {
    return this.current.get(agentId)?.audience ?? null;
  }

  room(agentId: string) {
    return this.current.get(agentId)?.roomId ?? null;
  }

  forget(agentId: string) {
    this.current.delete(agentId);
  }
}
