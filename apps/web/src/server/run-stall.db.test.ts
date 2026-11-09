import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq, inArray } from "drizzle-orm";

const url = process.env.TEST_DATABASE_URL;
const skip = !url && "set TEST_DATABASE_URL to a disposable Postgres to run";
if (url) process.env.DATABASE_URL = url;
process.env.BETTER_AUTH_SECRET ??= "test-secret";

const owner = "usr_stall_owner";
const agents = {
  quiet: "agt_stall_quiet",
  waiting: "agt_stall_waiting",
  busy: "agt_stall_busy",
  tools: "agt_stall_tools",
  queued: "agt_stall_queued",
  old: "agt_stall_old",
  undelivered: "agt_stall_undelivered",
};
const minutes = (count: number) => new Date(Date.now() - count * 60_000);

type Sent = { agentId: string; message: { type: string; runId?: string; reason?: string } };

function fakeHub() {
  const said: { agentId: string; role: string; text: string; runId?: string | null }[] = [];
  const toComputer: Sent[] = [];
  const hub = {
    broadcast: () => {},
    addMessage: async (agentId: string, role: string, text: string, runId?: string | null) => {
      said.push({ agentId, role, text, runId });
    },
    sendToComputer: (agentId: string, message: Sent["message"]) => {
      toComputer.push({ agentId, message });
      return true;
    },
    rooms: { relayRunClosed: async () => {} },
  };
  return { hub, said, toComputer };
}

async function runRow(id: string) {
  const { getDb, schema } = await import("@/lib/db");
  const [row] = await getDb().select().from(schema.runs).where(eq(schema.runs.id, id));
  return row;
}

before(async () => {
  if (!url) return;
  const { getDb, schema } = await import("@/lib/db");
  const db = getDb();
  await (await import("./test-db")).migrateTestDb();
  await db.delete(schema.user).where(eq(schema.user.id, owner));
  await db.insert(schema.user).values({ id: owner, name: "Owner", email: "stall-owner@test.local", status: "approved" });
  const look = { body: "pill", color: "#7FB2FF", eyes: "dot", acc: "none", accColor: "#2F3A56" };
  await db.insert(schema.agents).values(
    Object.values(agents).map((id) => ({ id, ownerId: owner, name: `Agent ${id}`, look, tokenHash: `hash_${id}`, tools: { notifyOwner: true, slack: false, slackChannels: [] } })) as never,
  );
  await db.insert(schema.runs).values([
    { id: "run_stall_quiet", agentId: agents.quiet, trigger: "schedule", status: "running", startedAt: minutes(40) },
    { id: "run_stall_waiting", agentId: agents.waiting, trigger: "schedule", status: "running", startedAt: minutes(120) },
    { id: "run_stall_busy", agentId: agents.busy, trigger: "schedule", status: "running", startedAt: minutes(120) },
    { id: "run_stall_tools", agentId: agents.tools, trigger: "schedule", status: "running", startedAt: minutes(60) },
    { id: "run_stall_working", agentId: agents.queued, trigger: "schedule", status: "running", startedAt: minutes(45) },
    { id: "run_stall_behind", agentId: agents.queued, trigger: "schedule", status: "running", startedAt: minutes(30) },
    { id: "run_stall_old", agentId: agents.old, trigger: "manual", status: "running", startedAt: minutes(3 * 24 * 60) },
    { id: "run_stall_undelivered", agentId: agents.undelivered, trigger: "schedule", status: "running", startedAt: minutes(25) },
  ]);
  await db.insert(schema.messages).values([
    { id: "msg_stall_1", agentId: agents.quiet, runId: "run_stall_quiet", role: "activity", text: "Reading the page", createdAt: minutes(30) },
    { id: "msg_stall_2", agentId: agents.quiet, runId: "run_stall_quiet", role: "activity", text: "Switching   tabs", createdAt: minutes(26) },
    { id: "msg_stall_3", agentId: agents.quiet, runId: null, role: "user", text: "are you there?", createdAt: minutes(2) },
    { id: "msg_stall_4", agentId: agents.waiting, runId: "run_stall_waiting", role: "activity", text: "Asking for approval: Send the board update", createdAt: minutes(100) },
    { id: "msg_stall_5", agentId: agents.busy, runId: "run_stall_busy", role: "activity", text: "Reading the page", createdAt: minutes(5) },
    { id: "msg_stall_6", agentId: agents.queued, runId: "run_stall_working", role: "agent", text: "Still reading posts", createdAt: minutes(2) },
    { id: "msg_stall_7", agentId: agents.old, runId: "run_stall_old", role: "activity", text: "Opening the report", createdAt: minutes(3 * 24 * 60 - 1) },
  ]);
  await db.insert(schema.approvals).values({ id: "apr_stall_wait", agentId: agents.waiting, runId: "run_stall_waiting", stepId: "s2", summary: "Send the board update", source: "mcp", status: "pending", createdAt: minutes(100), expiresAt: new Date(Date.now() + 22 * 60 * 60_000) });
  await db.insert(schema.toolCalls).values({ id: "tc_stall_1", agentId: agents.tools, tool: "notify_owner", ok: true, runId: null, createdAt: minutes(3) });
  await db.insert(schema.inboundQueue).values({ id: "inq_stall_1", agentId: agents.undelivered, message: { type: "run_recipe", runId: "run_stall_undelivered" }, source: "run", runId: "run_stall_undelivered", expiresAt: new Date(Date.now() + 5 * 60_000) });
});

after(async () => {
  if (!url) return;
  const { getDb, schema, getPool } = await import("@/lib/db");
  await getDb().delete(schema.runs).where(inArray(schema.runs.agentId, Object.values(agents)));
  await getDb().delete(schema.approvals).where(inArray(schema.approvals.agentId, Object.values(agents)));
  await getDb().delete(schema.user).where(eq(schema.user.id, owner));
  await getPool().end();
});

let swept: ReturnType<typeof fakeHub> | null = null;

async function sweepOnce() {
  if (swept) return swept;
  const { Runs } = await import("./hub/runs");
  swept = fakeHub();
  await new Runs(swept.hub as never).failStalled();
  return swept;
}

test("a run with no sign of life for 20 minutes and nothing waiting for the owner ends as failed, says why, and its turn is stopped", { skip }, async () => {
  const { said, toComputer } = await sweepOnce();
  const quiet = await runRow("run_stall_quiet");
  assert.equal(quiet.status, "failed");
  assert.ok(quiet.finishedAt);
  assert.match(quiet.summary ?? "", /stopped showing any activity at .+ \(last thing it did: Switching tabs\) and was not waiting for your approval, so the panel closed it after 20 minutes without activity/);
  assert.deepEqual(
    said.filter((line) => line.runId === "run_stall_quiet").map((line) => line.text),
    [`Did not finish: ${quiet.summary}`],
  );
  assert.deepEqual(toComputer.find((sent) => sent.message.runId === "run_stall_quiet"), { agentId: agents.quiet, message: { type: "run_stop", runId: "run_stall_quiet", reason: quiet.summary } });
});

test("a run that waits for the owner, works, calls tools, waits its turn behind other work or was not delivered yet keeps running", { skip }, async () => {
  const { toComputer } = await sweepOnce();
  for (const id of ["run_stall_waiting", "run_stall_busy", "run_stall_tools", "run_stall_working", "run_stall_behind", "run_stall_undelivered"]) {
    assert.equal((await runRow(id)).status, "running", `${id} keeps running`);
    assert.equal(toComputer.some((sent) => sent.message.runId === id), false, `${id} is not stopped`);
  }
  const { getDb, schema } = await import("@/lib/db");
  const [ask] = await getDb().select().from(schema.approvals).where(eq(schema.approvals.id, "apr_stall_wait"));
  assert.equal(ask.status, "pending");
});

test("a run left open for days is closed quietly, without a notice about something old", { skip }, async () => {
  const { said, toComputer } = await sweepOnce();
  const old = await runRow("run_stall_old");
  assert.equal(old.status, "failed");
  assert.match(old.summary ?? "", /last thing it did: Opening the report/);
  assert.equal(said.some((line) => line.agentId === agents.old), false);
  assert.ok(toComputer.some((sent) => sent.message.runId === "run_stall_old"));
});

test("the computer's late word on a run the panel already closed changes nothing", { skip }, async () => {
  const { Runs } = await import("./hub/runs");
  const { hub, said } = fakeHub();
  const runs = new Runs(hub as never);
  const before = await runRow("run_stall_quiet");
  await runs.finish(agents.quiet, "run_stall_quiet", false, "Stopped by the owner.", undefined, "stopped");
  const afterward = await runRow("run_stall_quiet");
  assert.equal(afterward.status, "failed");
  assert.equal(afterward.summary, before.summary);
  assert.equal(said.length, 0);
});

test("once the owner answers, a run that then goes silent is closed too", { skip }, async () => {
  const { Runs } = await import("./hub/runs");
  const { getDb, schema } = await import("@/lib/db");
  await getDb().update(schema.approvals).set({ status: "approved", answeredAt: minutes(21) }).where(eq(schema.approvals.id, "apr_stall_wait"));
  const { hub } = fakeHub();
  await new Runs(hub as never).failStalled();
  assert.equal((await runRow("run_stall_waiting")).status, "failed");
});

test("an owner who has not answered a run's request for an hour gets one reminder", { skip }, async () => {
  const { getDb, schema } = await import("@/lib/db");
  const { Approvals } = await import("./hub/approvals");
  await getDb().insert(schema.approvals).values([
    { id: "apr_stall_remind", agentId: agents.busy, runId: "run_stall_busy", stepId: "s2", summary: "Pay the invoice", source: "mcp", status: "pending", createdAt: minutes(62), expiresAt: new Date(Date.now() + 22 * 60 * 60_000) },
    { id: "apr_stall_fresh", agentId: agents.busy, runId: "run_stall_busy", summary: "Send the email", source: "mcp", status: "pending", createdAt: minutes(20), expiresAt: new Date(Date.now() + 22 * 60 * 60_000) },
    { id: "apr_stall_chat", agentId: agents.busy, runId: null, summary: "Post in the channel", source: "mcp", status: "pending", createdAt: minutes(62), expiresAt: new Date(Date.now() + 22 * 60 * 60_000) },
  ]);
  const sent: { to: string; text: string }[] = [];
  const send = async (to: { email: string }, text: string) => {
    sent.push({ to: to.email, text });
    return { ok: true };
  };
  const approvals = new Approvals({} as never);
  await approvals.remind(Date.now(), send as never);
  await approvals.remind(Date.now(), send as never);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "stall-owner@test.local");
  assert.match(sent[0].text, /still waiting for your answer, and the task stays paused until you answer: "Pay the invoice"[\s\S]*\/waiting\|Answer now>[\s\S]*\/runs\/run_stall_busy\|See the task>/);
  await getDb().delete(schema.approvals).where(inArray(schema.approvals.id, ["apr_stall_remind", "apr_stall_fresh", "apr_stall_chat"]));
});
