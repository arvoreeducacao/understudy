import WebSocket from "ws";
import { CDP_ENDPOINT } from "./browser.ts";

export type Target = { id: string; type: string; url: string; webSocketDebuggerUrl?: string };

export function cdpCall(socket: WebSocket, method: string, params: Record<string, unknown> = {}, timeoutMs = 0): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const timer = timeoutMs ? setTimeout(() => finish(new Error(`${method} timed out`)), timeoutMs) : null;
    const finish = (error: Error | null, result?: unknown) => {
      if (timer) clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      if (error) reject(error);
      else resolve(result);
    };
    const onMessage = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString());
      if (message.id !== id) return;
      if (message.error) finish(new Error(message.error.message));
      else finish(null, message.result);
    };
    const onClose = () => finish(new Error("the browser connection closed"));
    socket.on("message", onMessage);
    socket.on("close", onClose);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

export function cdpConnect(url: string, timeoutMs = 5000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { perMessageDeflate: false });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("could not connect to the browser in time"));
    }, timeoutMs);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export async function pageTargets(endpoint = CDP_ENDPOINT): Promise<Target[]> {
  const response = await fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(3000) });
  return ((await response.json()) as Target[]).filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
}

export async function browserSocketUrl(endpoint = CDP_ENDPOINT): Promise<string> {
  const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(3000) });
  const url = ((await response.json()) as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl;
  if (!url) throw new Error("the browser did not expose a debugging address");
  return url;
}
