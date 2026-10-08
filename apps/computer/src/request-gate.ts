import type WebSocket from "ws";
import { CDP_ENDPOINT } from "./browser.ts";
import { browserSocketUrl, cdpConnect } from "./cdp.ts";

export type GatedRequest = { method: string; url: string; body?: string; pageUrl: string; resourceType: string };

export type RequestGate = { close: () => Promise<void> };

type TargetInfo = { targetId: string; type: string; url: string };

const WATCHED_TYPES = new Set(["page", "iframe", "worker", "shared_worker", "service_worker"]);

export async function openRequestGate(onRequest: (request: GatedRequest) => Promise<boolean>, endpoint = CDP_ENDPOINT): Promise<RequestGate> {
  const socket: WebSocket = await cdpConnect(await browserSocketUrl(endpoint));
  const replies = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const sessionTarget = new Map<string, string>();
  const targetUrl = new Map<string, string>();
  const attached = new Set<string>();
  let nextId = 0;
  let closed = false;

  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> =>
    new Promise((resolve, reject) => {
      if (closed || socket.readyState !== socket.OPEN) return reject(new Error("the browser connection closed"));
      const id = ++nextId;
      replies.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  const watch = async (sessionId: string, info: TargetInfo) => {
    sessionTarget.set(sessionId, info.targetId);
    targetUrl.set(info.targetId, info.url);
    try {
      await send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sessionId);
      if (info.type === "page" || info.type === "iframe") await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
    } finally {
      await send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
    }
  };

  const paused = async (sessionId: string, params: any) => {
    const request = params.request ?? {};
    const pageUrl = targetUrl.get(sessionTarget.get(sessionId) ?? "") ?? "";
    let allowed = false;
    try {
      allowed = await onRequest({ method: String(request.method ?? "GET"), url: String(request.url ?? ""), body: typeof request.postData === "string" ? request.postData : undefined, pageUrl, resourceType: String(params.resourceType ?? "") });
    } catch {
      allowed = false;
    }
    if (allowed) await send("Fetch.continueRequest", { requestId: params.requestId }, sessionId).catch(() => {});
    else await send("Fetch.failRequest", { requestId: params.requestId, errorReason: "BlockedByClient" }, sessionId).catch(() => {});
  };

  socket.on("message", (data: WebSocket.RawData) => {
    let message: any;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (typeof message.id === "number" && replies.has(message.id)) {
      const reply = replies.get(message.id)!;
      replies.delete(message.id);
      if (message.error) reply.reject(new Error(message.error.message));
      else reply.resolve(message.result);
      return;
    }
    if (message.method === "Fetch.requestPaused" && message.sessionId) {
      void paused(message.sessionId, message.params);
      return;
    }
    if (message.method === "Target.attachedToTarget") {
      const { sessionId, targetInfo } = message.params as { sessionId: string; targetInfo: TargetInfo };
      if (!WATCHED_TYPES.has(targetInfo.type) || attached.has(targetInfo.targetId)) {
        void send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
        return;
      }
      attached.add(targetInfo.targetId);
      void watch(sessionId, targetInfo).catch(() => {});
      return;
    }
    if (message.method === "Target.targetInfoChanged" || message.method === "Target.targetCreated") {
      const info = message.params?.targetInfo as TargetInfo | undefined;
      if (info) targetUrl.set(info.targetId, info.url);
      return;
    }
    if (message.method === "Target.detachedFromTarget" && message.params?.sessionId) {
      const targetId = sessionTarget.get(message.params.sessionId);
      sessionTarget.delete(message.params.sessionId);
      if (targetId) attached.delete(targetId);
    }
  });

  socket.on("close", () => {
    closed = true;
    for (const reply of replies.values()) reply.reject(new Error("the browser connection closed"));
    replies.clear();
  });

  try {
    await send("Target.setDiscoverTargets", { discover: true });
    const { targetInfos } = (await send("Target.getTargets")) as { targetInfos: TargetInfo[] };
    for (const info of targetInfos.filter((target) => target.type === "page")) {
      if (attached.has(info.targetId)) continue;
      attached.add(info.targetId);
      const { sessionId } = (await send("Target.attachToTarget", { targetId: info.targetId, flatten: true })) as { sessionId: string };
      await watch(sessionId, info);
    }
    await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  } catch (error) {
    socket.terminate();
    throw error;
  }

  return {
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
        socket.close();
        setTimeout(() => {
          socket.terminate();
          resolve();
        }, 1000);
      });
    },
  };
}
