import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { after, before, test } from "node:test";
import { eq, inArray } from "drizzle-orm";

const url = process.env.TEST_DATABASE_URL;
const skip = !url && "set TEST_DATABASE_URL to a disposable Postgres to run";
if (url) process.env.DATABASE_URL = url;
process.env.BETTER_AUTH_SECRET ??= "test-secret";

const ids = { owner: "usr_idle_owner", quiet: "agt_idle_quiet", watched: "agt_idle_watched" };
const look = { body: "pill", color: "#7FB2FF", eyes: "dot", acc: "none", accColor: "#2F3A56" };
const tools = { notifyOwner: true, slack: false, slackChannels: [] };
const longAgo = Date.now() - 31 * 60 * 1000;

function fakeSocket() {
  const ws = Object.assign(new EventEmitter(), {
    OPEN: 1,
    readyState: 1,
    received: [] as { type: string; agentId?: string; spec?: { agentId: string } }[],
    send(raw: string) {
      ws.received.push(JSON.parse(raw));
    },
    ping() {},
    close() {
      ws.readyState = 3;
      ws.emit("close");
    },
  });
  return ws;
}

before(async () => {
  if (!url) return;
  await (await import("./test-db")).migrateTestDb();
  const { getDb, schema } = await import("@/lib/db");
  const db = getDb();
  await db.delete(schema.user).where(eq(schema.user.id, ids.owner));
  await db.insert(schema.user).values({ id: ids.owner, name: "Owner", email: "idle-owner@test.local", status: "approved" });
  await db.insert(schema.agents).values([
    { id: ids.quiet, ownerId: ids.owner, name: "Q", look, tokenHash: "idle_q", tools, computerStatus: "running", hostId: "host-idle", lastSeenAt: new Date() } as never,
    { id: ids.watched, ownerId: ids.owner, name: "W", look, tokenHash: "idle_w", tools, computerStatus: "running", hostId: "host-idle", lastSeenAt: new Date() } as never,
  ]);
});

after(async () => {
  if (!url) return;
  const { getDb, schema, getPool } = await import("@/lib/db");
  await getDb().delete(schema.user).where(inArray(schema.user.id, [ids.owner]));
  await getPool().end();
  setTimeout(() => process.exit(0), 100).unref();
});

test("an idle computer goes to sleep, stays asleep when the host reconnects, and wakes up for the next message", { skip }, async () => {
  const { Hub } = await import("./hub");
  const { getDb, schema } = await import("@/lib/db");
  const db = getDb();
  const hub = new Hub();
  const host = fakeSocket();
  const conn = { ws: host, hostId: "host-idle", capacity: 4, running: new Set([ids.quiet]) };
  (hub.hosts as unknown as { hosts: Map<string, unknown> }).hosts.set("host-idle", conn);
  const computer = fakeSocket();
  await hub.attachComputer(computer as never, ids.quiet);
  hub.idle.touch(ids.quiet, longAgo);

  await hub.idle.sweep();
  assert.deepEqual(host.received, [{ type: "computer_stop", agentId: ids.quiet }]);
  assert.equal(conn.running.size, 0);

  const hosts = hub.hosts as unknown as { onComputerStatus(c: unknown, m: unknown): Promise<void>; reconcile(c: unknown): Promise<void> };
  await hosts.onComputerStatus(conn, { type: "computer_status", agentId: ids.quiet, status: "stopped" });
  computer.close();
  const [asleep] = await db.select().from(schema.agents).where(eq(schema.agents.id, ids.quiet));
  assert.equal(asleep.computerStatus, "sleeping");

  host.received.length = 0;
  await hosts.reconcile(conn);
  assert.equal(host.received.filter((m) => m.spec?.agentId === ids.quiet).length, 0);
  host.received.length = 0;

  const result = await hub.deliver(ids.quiet, { type: "chat", text: "wake up", from: "Owner" }, { source: "panel" });
  assert.deepEqual(result, { status: "queued", starting: true });
  assert.deepEqual(host.received.map((m) => [m.type, m.spec?.agentId]), [["computer_ensure", ids.quiet]]);
});

test("a computer someone is looking at, or one watching a page, stays on", { skip }, async () => {
  const { Hub } = await import("./hub");
  const { getDb, schema } = await import("@/lib/db");
  const db = getDb();
  await db.update(schema.agents).set({ computerStatus: "running" }).where(eq(schema.agents.id, ids.quiet));
  await db.insert(schema.recipes).values({ id: "rcp_idle_watch", agentId: ids.watched, recipe: {}, active: true } as never);
  await db.insert(schema.recipeWatches).values({ recipeId: "rcp_idle_watch", agentId: ids.watched, url: "https://example.com", everyMinutes: 60 } as never);
  const hub = new Hub();
  const host = fakeSocket();
  (hub.hosts as unknown as { hosts: Map<string, unknown> }).hosts.set("host-idle", { ws: host, hostId: "host-idle", capacity: 4, running: new Set([ids.quiet, ids.watched]) });
  const quiet = fakeSocket();
  const watched = fakeSocket();
  await hub.attachComputer(quiet as never, ids.quiet);
  await hub.attachComputer(watched as never, ids.watched);
  await hub.attachViewer(fakeSocket() as never, ids.quiet, ids.owner);
  hub.idle.touch(ids.quiet, longAgo);
  hub.idle.touch(ids.watched, longAgo);

  await hub.idle.sweep();
  assert.deepEqual(host.received, []);
  quiet.close();
  watched.close();
});
