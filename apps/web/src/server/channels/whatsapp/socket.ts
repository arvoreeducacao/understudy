import makeWASocket, { Browsers, makeCacheableSignalKeyStore, type AnyMessageContent, type AuthenticationState, type WAMessage } from "baileys";

export type WaConnectionUpdate = { connection?: "open" | "close" | "connecting"; qr?: string; lastDisconnect?: { error?: unknown } };

export type WaEvents = {
  "connection.update": (update: WaConnectionUpdate) => void;
  "creds.update": () => void;
  "messages.upsert": (upsert: { messages: WAMessage[]; type: string }) => void;
};

export type WaSocket = {
  ev: { on<K extends keyof WaEvents>(event: K, handler: WaEvents[K]): void };
  user?: { id: string; lid?: string; name?: string };
  sendMessage(jid: string, content: AnyMessageContent, options?: { messageId?: string }): Promise<unknown>;
  sendPresenceUpdate(type: "composing" | "paused" | "available" | "unavailable", jid?: string): Promise<void>;
  logout(): Promise<void>;
  end(error: Error | undefined): void;
};

export type SocketFactory = (auth: AuthenticationState, name: string) => WaSocket;

type QuietLogger = {
  level: string;
  child(bindings: Record<string, unknown>): QuietLogger;
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
};

const silent: QuietLogger = {
  level: "silent",
  child: () => silent,
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export const baileysSocket: SocketFactory = (auth, name) =>
  makeWASocket({
    auth: { creds: auth.creds, keys: makeCacheableSignalKeyStore(auth.keys, silent) },
    logger: silent,
    browser: Browsers.macOS(name.slice(0, 40) || "Understudy"),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    generateHighQualityLinkPreview: false,
  }) as unknown as WaSocket;
