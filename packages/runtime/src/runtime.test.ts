import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { backoffDelay, openLink } from "./index.ts";

test("backoff grows and caps at thirty seconds", () => {
  assert.equal(backoffDelay(0, () => 0), 500);
  assert.equal(backoffDelay(3, () => 1), 8000);
  assert.equal(backoffDelay(20, () => 1), 30000);
});

test("the link sends the bearer token and only delivers messages its parser accepts", async () => {
  const server = new WebSocketServer({ port: 0 });
  const port = (server.address() as { port: number }).port;
  let authorization = "";
  server.on("connection", (socket, request) => {
    authorization = request.headers.authorization ?? "";
    socket.send("not json");
    socket.send(JSON.stringify({ type: "bad" }));
    socket.send(JSON.stringify({ type: "good", n: 1 }));
  });
  const received: unknown[] = [];
  await new Promise<void>((resolve) => {
    const link = openLink<{ type: "good"; n: number }, object>({
      url: `ws://127.0.0.1:${port}`,
      token: "secret",
      parse: (raw) => {
        try {
          const value = JSON.parse(String(raw));
          return value.type === "good" ? { ok: true, message: value } : { ok: false, error: "not good" };
        } catch {
          return { ok: false, error: "not JSON" };
        }
      },
      onOpen: () => {},
      onMessage: (message) => {
        received.push(message);
        link.close();
        resolve();
      },
    });
  });
  server.close();
  assert.equal(authorization, "Bearer secret");
  assert.deepEqual(received, [{ type: "good", n: 1 }]);
});
