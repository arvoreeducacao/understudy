import { randomBytes } from "node:crypto";
import { DisconnectReason, downloadMediaMessage, type AnyMessageContent, type WAMessage } from "baileys";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { messages as copy } from "@/lib/messages";
import type { Hub } from "../../hub";
import { sendPush } from "../../push";
import { RateLimiter } from "../../rate-limit";
import { mergeChannelSettings } from "../store";
import { clearWhatsAppSession, hasWhatsAppSession, sealedAuthState } from "./auth-state";
import { handleWhatsAppMessage } from "./inbound";
import { identityOf, OWN_MESSAGE_PREFIX, paceMs, readMessage, type WaIdentity } from "./message";
import { baileysSocket, type SocketFactory, type WaSocket } from "./socket";

export type WhatsAppState = "connecting" | "qr" | "open" | "closed" | "logged_out";

type Session = { channelId: string; socket: WaSocket | null; state: WhatsAppState; qr: string | null; me: WaIdentity | null; attempts: number; stopped: boolean; inbox: Promise<unknown>; outbox: Promise<unknown>; timer: NodeJS.Timeout | null };

export type SessionOptions = { backoff?: number[]; factory?: SocketFactory; sleep?: (ms: number) => Promise<void>; pace?: (text: string) => number; now?: () => number; download?: (message: WAMessage, maxBytes: number) => Promise<Buffer | null> };

const BACKOFF_MS = [2000, 5000, 15000, 30000, 60000];
const SEND_RATE_PER_SECOND = 0.25;
const SEND_BURST = 8;

function log(event: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
}

function statusCode(error: unknown) {
  const value = error as { output?: { statusCode?: number } } | undefined;
  return value?.output?.statusCode ?? 0;
}

async function isLinked(channelId: string) {
  const [row] = await getDb().select({ settings: schema.agentChannels.settings }).from(schema.agentChannels).where(eq(schema.agentChannels.id, channelId));
  return Boolean(row && (row.settings as { linked?: boolean }).linked);
}

export async function readCapped(stream: AsyncIterable<unknown> & { destroy?: (error?: Error) => void }, maxBytes: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += piece.length;
    if (size > maxBytes) {
      stream.destroy?.();
      return null;
    }
    chunks.push(piece);
  }
  return Buffer.concat(chunks);
}

export function ownMessageId() {
  return `${OWN_MESSAGE_PREFIX}${randomBytes(8).toString("hex").toUpperCase()}`;
}

export class WhatsAppSessions {
  private sessions = new Map<string, Session>();
  private limiter = new RateLimiter();
  private factory: SocketFactory;
  private sleep: (ms: number) => Promise<void>;
  private pace: (text: string) => number;
  private now: () => number;
  private download: (message: WAMessage, maxBytes: number) => Promise<Buffer | null>;
  private backoff: number[];

  constructor(
    private hub: Hub,
    options: SessionOptions = {},
  ) {
    this.factory = options.factory ?? baileysSocket;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.pace = options.pace ?? ((text) => paceMs(text));
    this.now = options.now ?? Date.now;
    this.backoff = options.backoff ?? BACKOFF_MS;
    this.download = options.download ?? (async (message, maxBytes) => readCapped(await downloadMediaMessage(message, "stream", {}), maxBytes));
  }

  status(channelId: string) {
    const session = this.sessions.get(channelId);
    return session ? { state: session.state, qr: session.qr, number: session.me?.number ?? null } : null;
  }

  identity(channelId: string) {
    return this.sessions.get(channelId)?.me ?? null;
  }

  async restore() {
    const rows = await getDb().select({ id: schema.agentChannels.id }).from(schema.agentChannels).where(eq(schema.agentChannels.kind, "whatsapp"));
    for (const row of rows) if ((await isLinked(row.id)) && (await hasWhatsAppSession(row.id))) await this.start(row.id).catch((error) => log("whatsapp_restore_error", { channelId: row.id, error: String(error) }));
  }

  async start(channelId: string) {
    const existing = this.sessions.get(channelId);
    if (existing && !existing.stopped && existing.state !== "closed" && existing.state !== "logged_out") return existing;
    const session: Session = existing ?? { channelId, socket: null, state: "connecting", qr: null, me: null, attempts: 0, stopped: false, inbox: Promise.resolve(), outbox: Promise.resolve(), timer: null };
    session.stopped = false;
    session.state = "connecting";
    this.sessions.set(channelId, session);
    await this.connect(session);
    return session;
  }

  private async agentName(channelId: string) {
    const [row] = await getDb()
      .select({ name: schema.agents.name })
      .from(schema.agentChannels)
      .innerJoin(schema.agents, eq(schema.agents.id, schema.agentChannels.agentId))
      .where(eq(schema.agentChannels.id, channelId));
    return row?.name ?? "";
  }

  private async connect(session: Session) {
    const { state, saveCreds } = await sealedAuthState(session.channelId);
    const socket = this.factory(state, await this.agentName(session.channelId));
    session.socket = socket;
    socket.ev.on("creds.update", () => {
      saveCreds().catch((error) => log("whatsapp_creds_error", { channelId: session.channelId, error: String(error) }));
    });
    socket.ev.on("connection.update", (update) => {
      this.onConnection(session, socket, update).catch((error) => log("whatsapp_connection_error", { channelId: session.channelId, error: String(error) }));
    });
    socket.ev.on("messages.upsert", (upsert) => {
      if (upsert.type !== "notify") return;
      session.inbox = session.inbox.then(() => this.onMessages(session, upsert.messages)).catch((error) => log("whatsapp_message_error", { channelId: session.channelId, error: String(error) }));
    });
  }

  private async onConnection(session: Session, socket: WaSocket, update: { connection?: string; qr?: string; lastDisconnect?: { error?: unknown } }) {
    if (session.socket !== socket) return;
    if (update.qr) {
      session.state = "qr";
      session.qr = update.qr;
    }
    if (update.connection === "open") {
      session.state = "open";
      session.qr = null;
      session.attempts = 0;
      session.me = identityOf(socket.user);
      if (session.me) await mergeChannelSettings(session.channelId, { number: session.me.number, linked: true });
      log("whatsapp_open", { channelId: session.channelId });
    }
    if (update.connection === "close") {
      const code = statusCode(update.lastDisconnect?.error);
      session.socket = null;
      if (session.stopped) {
        session.state = "closed";
        return;
      }
      if (code === DisconnectReason.loggedOut || code === DisconnectReason.forbidden || code === DisconnectReason.badSession) return this.lost(session);
      if (!(await isLinked(session.channelId)) && session.state === "qr" && code === DisconnectReason.timedOut) {
        session.state = "closed";
        session.qr = null;
        return;
      }
      const wait = code === DisconnectReason.restartRequired ? 0 : this.backoff[Math.min(session.attempts, this.backoff.length - 1)];
      session.attempts += 1;
      session.state = "connecting";
      log("whatsapp_reconnect", { channelId: session.channelId, code, wait });
      session.timer = setTimeout(() => {
        session.timer = null;
        if (!session.stopped) this.connect(session).catch((error) => log("whatsapp_connect_error", { channelId: session.channelId, error: String(error) }));
      }, wait);
      session.timer.unref?.();
    }
  }

  private async lost(session: Session) {
    session.state = "logged_out";
    session.qr = null;
    const wasLinked = await isLinked(session.channelId);
    await clearWhatsAppSession(session.channelId);
    await mergeChannelSettings(session.channelId, { linked: false });
    log("whatsapp_logged_out", { channelId: session.channelId });
    if (!wasLinked) return;
    const [row] = await getDb()
      .select({ agentId: schema.agentChannels.agentId, ownerId: schema.agents.ownerId, name: schema.agents.name })
      .from(schema.agentChannels)
      .innerJoin(schema.agents, eq(schema.agents.id, schema.agentChannels.agentId))
      .where(eq(schema.agentChannels.id, session.channelId));
    if (!row) return;
    await this.hub.approvals.notifyOwner(row.agentId, copy.channels.whatsappLost).catch((error) => log("whatsapp_notify_error", { error: String(error) }));
    sendPush([row.ownerId], { title: copy.channels.whatsappLostTitle(row.name), body: copy.channels.whatsappLost, url: `/agents/${row.agentId}?tab=settings`, tag: `whatsapp-${session.channelId}` }).catch(() => undefined);
  }

  private async onMessages(session: Session, list: WAMessage[]) {
    if (!session.me) return;
    for (const raw of list) {
      const inbound = readMessage(raw);
      if (!inbound) continue;
      const media = inbound.media;
      const fetchMedia = media ? (maxBytes: number) => this.download(raw, maxBytes) : null;
      const outcome = await handleWhatsAppMessage(this.hub, { channelId: session.channelId, me: session.me, inbound, fetchMedia, reply: (text) => this.send(session.channelId, session.me?.jid ?? "", { text }), now: this.now() });
      log("whatsapp_message", { channelId: session.channelId, outcome });
    }
  }

  async send(channelId: string, jid: string, content: AnyMessageContent) {
    const session = this.sessions.get(channelId);
    if (!session) throw new Error("whatsapp is not connected");
    const run = session.outbox.then(async () => {
      for (let tries = 0; !this.limiter.allow(`whatsapp-send:${channelId}`, SEND_RATE_PER_SECOND, SEND_BURST); tries++) {
        if (tries > 30) throw new Error("whatsapp send rate exceeded");
        await this.sleep(4000);
      }
      const socket = session.socket;
      if (!socket || session.state !== "open") throw new Error("whatsapp is not connected");
      const text = "text" in content && typeof content.text === "string" ? content.text : "";
      await socket.sendPresenceUpdate("composing", jid).catch(() => undefined);
      await this.sleep(this.pace(text));
      await socket.sendMessage(jid, content, { messageId: ownMessageId() });
      await socket.sendPresenceUpdate("paused", jid).catch(() => undefined);
    });
    session.outbox = run.catch(() => undefined);
    return run;
  }

  async stop(channelId: string, logout: boolean) {
    const session = this.sessions.get(channelId);
    if (session) {
      session.stopped = true;
      if (session.timer) clearTimeout(session.timer);
      const socket = session.socket;
      session.socket = null;
      session.state = "closed";
      if (socket && logout) await socket.logout().catch(() => undefined);
      socket?.end(undefined);
      this.sessions.delete(channelId);
    }
    if (logout) await clearWhatsAppSession(channelId);
  }
}
