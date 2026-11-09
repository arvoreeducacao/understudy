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
  late: "agt_stall_late",
  queued: "agt_stall_queued",
  lonely: "agt_stall_lonely",
  old: "agt_stall_old",
  expired: "agt_stall_expired",
  undelivered: "agt_stall_undelivered",
  slow: "agt_stall_slow",
  hourly: "agt_stall_hourly",
  undated: "agt_stall_undated",
  expiring: "agt_stall_expiring",
  idleQueue: "agt_stall_idle_queue",
};
const minutes = (count: number) => new Date(Date.now() - count * 60_000);
const day = 24 * 60;
const later = new Date(Date.now() + 22 * 60 * 60_000);

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
  await db.insert(schema.recipes).values({ id: "rcp_stall_hourly", agentId: agents.hourly, recipe: { title: "Hourly digest", trigger: "x", steps: [], questions: [], askFirstRuns: 0 }, active: true } as never);
  await db.insert(schema.runs).values([
    { id: "run_stall_quiet", agentId: agents.quiet, trigger: "schedule", status: "running", startedAt: minutes(60) },
    { id: "run_stall_waiting", agentId: agents.waiting, trigger: "schedule", status: "running", startedAt: minutes(120) },
    { id: "run_stall_busy", agentId: agents.busy, trigger: "schedule", status: "running", startedAt: minutes(120) },
    { id: "run_stall_late", agentId: agents.late, trigger: "schedule", status: "running", startedAt: minutes(120) },
    { id: "run_stall_working", agentId: agents.queued, trigger: "schedule", status: "running", startedAt: minutes(60) },
    { id: "run_stall_behind", agentId: agents.queued, trigger: "schedule", status: "running", startedAt: minutes(50) },
    { id: "run_stall_lonely", agentId: agents.lonely, trigger: "schedule", status: "running", startedAt: minutes(50) },
    { id: "run_stall_old", agentId: agents.old, trigger: "manual", status: "running", startedAt: minutes(3 * day) },
    { id: "run_stall_expired", agentId: agents.expired, trigger: "schedule", status: "running", startedAt: minutes(day + 120) },
    { id: "run_stall_undelivered", agentId: agents.undelivered, trigger: "schedule", status: "running", startedAt: minutes(50) },
    { id: "run_stall_slow", agentId: agents.slow, trigger: "schedule", status: "running", startedAt: minutes(60) },
    { id: "run_stall_hourly", agentId: agents.hourly, recipeId: "rcp_stall_hourly", trigger: "schedule", status: "running", startedAt: minutes(65) },
    { id: "run_stall_undated", agentId: agents.undated, trigger: "schedule", status: "running", startedAt: minutes(26 * 60) },
    { id: "run_stall_undated_queued", agentId: agents.undated, trigger: "schedule", status: "running", startedAt: minutes(50) },
    { id: "run_stall_expiring", agentId: agents.expiring, trigger: "schedule", status: "running", startedAt: minutes(day + 40) },
    { id: "run_stall_idle_done", agentId: agents.idleQueue, trigger: "schedule", status: "ok", startedAt: minutes(80) },
    { id: "run_stall_idle_queued", agentId: agents.idleQueue, trigger: "schedule", status: "running", startedAt: minutes(80) },
  ]);
  await db.insert(schema.messages).values([
    { id: "msg_stall_1", agentId: agents.quiet, runId: "run_stall_quiet", role: "activity", text: "Reading the page", createdAt: minutes(50) },
    { id: "msg_stall_2", agentId: agents.quiet, runId: "run_stall_quiet", role: "activity", text: "Switching   tabs", createdAt: minutes(40) },
    { id: "msg_stall_3", agentId: agents.quiet, runId: null, role: "user", text: "are you there?", createdAt: minutes(2) },
    { id: "msg_stall_4", agentId: agents.quiet, runId: "run_stall_quiet", role: "system", text: "Blocked without asking: a tracker", createdAt: minutes(2) },
    { id: "msg_stall_5", agentId: agents.waiting, runId: "run_stall_waiting", role: "activity", text: "Asking for approval: Send the board update", createdAt: minutes(100) },
    { id: "msg_stall_6", agentId: agents.busy, runId: "run_stall_busy", role: "activity", text: "Reading the page", createdAt: minutes(5) },
    { id: "msg_stall_7", agentId: agents.late, runId: "run_stall_late", role: "activity", text: "Asking for approval: Send the board update", createdAt: minutes(100) },
    { id: "msg_stall_8", agentId: agents.queued, runId: "run_stall_working", role: "agent", text: "Still reading posts", createdAt: minutes(2) },
    { id: "msg_stall_9", agentId: agents.old, runId: "run_stall_old", role: "activity", text: "Opening the report", createdAt: minutes(3 * day - 1) },
    { id: "msg_stall_10", agentId: agents.expired, runId: "run_stall_expired", role: "activity", text: "Asking for approval: Pay the invoice", createdAt: minutes(day + 110) },
    { id: "msg_stall_11", agentId: agents.slow, runId: "run_stall_slow", role: "activity", text: "evaluate", createdAt: minutes(30) },
    { id: "msg_stall_13", agentId: agents.undated, runId: "run_stall_undated", role: "activity", text: "Asking for approval: Export the report", createdAt: minutes(25 * 60) },
    { id: "msg_stall_14", agentId: agents.expiring, runId: "run_stall_expiring", role: "activity", text: "Asking for approval: Pay the invoice", createdAt: minutes(day + 1) },
    { id: "msg_stall_15", agentId: agents.idleQueue, runId: "run_stall_idle_done", role: "activity", text: "Wrapping up", createdAt: minutes(40) },
    { id: "msg_stall_12", agentId: agents.hourly, runId: "run_stall_hourly", role: "activity", text: "Asking for approval: Post the digest", createdAt: minutes(60) },
  ]);
  await db.insert(schema.approvals).values([
    { id: "apr_stall_chat", agentId: agents.quiet, runId: null, summary: "Post in the channel", source: "mcp", status: "pending", createdAt: minutes(10), expiresAt: later },
    { id: "apr_stall_wait", agentId: agents.waiting, runId: "run_stall_waiting", stepId: "s2", summary: "Send the board update", source: "mcp", status: "pending", createdAt: minutes(100), expiresAt: later },
    { id: "apr_stall_late", agentId: agents.late, runId: "run_stall_late", stepId: "s2", summary: "Send the board update", source: "mcp", status: "approved", createdAt: minutes(100), answeredAt: minutes(50), expiresAt: later },
    { id: "apr_stall_expired", agentId: agents.expired, runId: "run_stall_expired", stepId: "s2", summary: "Pay the invoice", source: "mcp", status: "expired", createdAt: minutes(day + 110), answeredAt: minutes(50), expiresAt: minutes(50) },
    { id: "apr_stall_undated", agentId: agents.undated, runId: "run_stall_undated", stepId: "s2", summary: "Export the report", source: "computer", status: "pending", createdAt: minutes(25 * 60), expiresAt: null },
    { id: "apr_stall_expiring", agentId: agents.expiring, runId: "run_stall_expiring", stepId: "s2", summary: "Pay the invoice", source: "mcp", status: "pending", createdAt: minutes(day + 1), expiresAt: new Date(Date.now() - 2000) },
    { id: "apr_stall_hourly", agentId: agents.hourly, runId: "run_stall_hourly", stepId: "s1", summary: "Post the digest", source: "mcp", status: "pending", createdAt: minutes(60), expiresAt: later },
  ]);
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

let swept: (ReturnType<typeof fakeHub> & { runs: InstanceType<typeof import("./hub/runs").Runs> }) | null = null;

async function sweepOnce() {
  if (swept) return swept;
  const { Runs } = await import("./hub/runs");
  const fake = fakeHub();
  const runs = new Runs(fake.hub as never);
  await runs.failStalled();
  swept = { ...fake, runs };
  return swept;
}

test("a run whose computer said nothing for 35 minutes ends as failed, says what it last did, and its turn is stopped", { skip }, async () => {
  const { said, toComputer } = await sweepOnce();
  const quiet = await runRow("run_stall_quiet");
  assert.equal(quiet.status, "failed");
  assert.ok(quiet.finishedAt);
  assert.match(quiet.summary ?? "", /^Nothing came from its computer after .+ \(last thing it did: Switching tabs\), so the panel closed the run after 35 minutes without activity\.$/);
  assert.deepEqual(
    said.filter((line) => line.runId === "run_stall_quiet").map((line) => line.text),
    [`Did not finish: ${quiet.summary}`],
  );
  assert.deepEqual(toComputer.find((sent) => sent.message.runId === "run_stall_quiet"), { agentId: agents.quiet, message: { type: "run_stop", runId: "run_stall_quiet", reason: quiet.summary } });
});

test("only the run's own computer activity and the run's own approvals keep it open", { skip }, async () => {
  await sweepOnce();
  const { getDb, schema } = await import("@/lib/db");
  const [chat] = await getDb().select().from(schema.approvals).where(eq(schema.approvals.id, "apr_stall_chat"));
  assert.equal(chat.status, "pending");
  assert.equal((await runRow("run_stall_quiet")).status, "failed");
});

test("a run that waits for the owner, works, waits its turn behind other work, was not delivered yet or has been silent for under 35 minutes keeps running", { skip }, async () => {
  const { toComputer } = await sweepOnce();
  for (const id of ["run_stall_waiting", "run_stall_busy", "run_stall_behind", "run_stall_undelivered", "run_stall_slow", "run_stall_hourly"]) {
    assert.equal((await runRow(id)).status, "running", `${id} keeps running`);
    assert.equal(toComputer.some((sent) => sent.message.runId === id), false, `${id} is not stopped`);
  }
});

test("a run its computer never started is closed with words that say so", { skip }, async () => {
  await sweepOnce();
  const lonely = await runRow("run_stall_lonely");
  assert.equal(lonely.status, "failed");
  assert.match(lonely.summary ?? "", /^Its computer never started this run: nothing came from it for 35 minutes after .+, so the panel closed the run\.$/);
});

test("an answer that came after the computer went quiet is named in the summary as not used", { skip }, async () => {
  const { said } = await sweepOnce();
  const late = await runRow("run_stall_late");
  assert.equal(late.status, "failed");
  assert.match(late.summary ?? "", /Your answer to "Send the board update" at .+ came after that and was not used\.$/);
  assert.ok(said.some((line) => line.runId === "run_stall_late" && line.text.startsWith("Did not finish:")));
});

test("a run left open for days is closed quietly, but one whose request just expired is closed with the usual notice", { skip }, async () => {
  const { said, toComputer } = await sweepOnce();
  const old = await runRow("run_stall_old");
  assert.equal(old.status, "failed");
  assert.match(old.summary ?? "", /last thing it did: Opening the report/);
  assert.equal(said.some((line) => line.agentId === agents.old), false);
  assert.ok(toComputer.some((sent) => sent.message.runId === "run_stall_old"));
  const expired = await runRow("run_stall_expired");
  assert.equal(expired.status, "failed");
  assert.ok(said.some((line) => line.runId === "run_stall_expired" && line.text.startsWith("Did not finish:")));
});

test("the computer's late word on a closed run changes nothing and gets the stop order again, at most once a minute", { skip }, async () => {
  const { runs, toComputer } = await sweepOnce();
  const before = await runRow("run_stall_quiet");
  const stops = () => toComputer.filter((sent) => sent.message.runId === "run_stall_quiet").length;
  const first = stops();
  await runs.finish(agents.quiet, "run_stall_quiet", false, "Stopped by the owner.", undefined, "stopped");
  const afterward = await runRow("run_stall_quiet");
  assert.equal(afterward.status, "failed");
  assert.equal(afterward.summary, before.summary);
  runs.noteRunSign(agents.quiet, "run_stall_quiet");
  assert.equal(stops(), first);
  assert.equal(runs.resendStop(agents.quiet, "run_stall_quiet", before.summary ?? "", Date.now() + 61_000), true);
  assert.equal(stops(), first + 1);
  runs.noteRunSign("agt_someone_else", "run_stall_quiet");
  assert.equal(stops(), first + 1);
});

test("a request with no expiry that is more than a day old no longer holds a run open", { skip }, async () => {
  await sweepOnce();
  assert.equal((await runRow("run_stall_undated")).status, "failed");
  assert.equal((await runRow("run_stall_undated_queued")).status, "failed");
});

test("a request that has just passed its expiry still counts as news for its run, so the run hears the expiry instead of being closed as silent", { skip }, async () => {
  await sweepOnce();
  assert.equal((await runRow("run_stall_expiring")).status, "running");
});

test("a queued run its computer never picked up says when the computer was last heard from", { skip }, async () => {
  const { formatWhen } = await import("@/lib/format");
  const { getDb, schema } = await import("@/lib/db");
  await sweepOnce();
  const [last] = await getDb().select().from(schema.messages).where(eq(schema.messages.id, "msg_stall_15"));
  const queued = await runRow("run_stall_idle_queued");
  assert.equal(queued.status, "failed");
  assert.equal(queued.summary, `Its computer never started this run: nothing came from it for 35 minutes after ${formatWhen(last.createdAt)}, so the panel closed the run.`);
});

test("a computer that comes back gets the stop orders for its closed runs again", { skip }, async () => {
  const { runs, toComputer } = await sweepOnce();
  const before = toComputer.filter((sent) => sent.agentId === agents.quiet).length;
  assert.equal(runs.resendStopsFor(agents.quiet), 1);
  const resent = toComputer.filter((sent) => sent.agentId === agents.quiet);
  assert.equal(resent.length, before + 1);
  assert.deepEqual(resent.at(-1)!.message, { type: "run_stop", runId: "run_stall_quiet", reason: (await runRow("run_stall_quiet")).summary });
});

test("a run's approvals come with the pending ones first, however many it has", { skip }, async () => {
  const { getDb, schema } = await import("@/lib/db");
  const { Approvals } = await import("./hub/approvals");
  const many = Array.from({ length: 105 }, (_, index) => ({ id: `apr_stall_many_${index}`, agentId: agents.busy, runId: "run_stall_busy", summary: `Item ${index}`, source: "mcp" as const, status: "approved" as const, createdAt: minutes(200 - index), answeredAt: minutes(199 - index) }));
  await getDb().insert(schema.approvals).values([...many, { id: "apr_stall_newest", agentId: agents.busy, runId: "run_stall_busy", summary: "Newest item", source: "mcp", status: "pending", createdAt: minutes(1), expiresAt: later }]);
  try {
    const rows = await new Approvals({} as never).forRun(agents.busy, "run_stall_busy");
    assert.equal(rows.length, 100);
    assert.equal(rows[0].id, "apr_stall_newest");
    assert.equal(rows[1].id, "apr_stall_many_104");
  } finally {
    await getDb().delete(schema.approvals).where(inArray(schema.approvals.id, [...many.map((row) => row.id), "apr_stall_newest"]));
  }
});

test("a scheduled run of a task that still has an open run is skipped and noted, not queued", { skip }, async () => {
  const { Runs } = await import("./hub/runs");
  const { getDb, schema } = await import("@/lib/db");
  const { hub, said } = fakeHub();
  const runs = new Runs(hub as never);
  const started = await runs.start("rcp_stall_hourly", "schedule", { scheduledFor: new Date() });
  assert.deepEqual(started, { ok: false, reason: "already_running" });
  assert.deepEqual(await runs.start("rcp_stall_hourly", "schedule", { scheduledFor: new Date(Date.now() + 300_000) }), { ok: false, reason: "already_running" });
  const rows = await getDb().select().from(schema.runs).where(eq(schema.runs.recipeId, "rcp_stall_hourly"));
  assert.deepEqual(rows.map((row) => row.id), ["run_stall_hourly"]);
  assert.equal(said.length, 1);
  assert.match(said[0].text, /^Skipped a scheduled run of Hourly digest: the run from .+ is still open\.$/);
  assert.equal(said[0].runId, "run_stall_hourly");
});

test("once the owner answers, a run that then goes silent is closed too", { skip }, async () => {
  const { Runs } = await import("./hub/runs");
  const { getDb, schema } = await import("@/lib/db");
  await getDb().update(schema.approvals).set({ status: "approved", answeredAt: minutes(36) }).where(eq(schema.approvals.id, "apr_stall_wait"));
  const { hub } = fakeHub();
  await new Runs(hub as never).failStalled();
  assert.equal((await runRow("run_stall_waiting")).status, "failed");
});

test("an owner who has not answered a run's request for an hour gets one reminder", { skip }, async () => {
  const { getDb, schema } = await import("@/lib/db");
  const { Approvals } = await import("./hub/approvals");
  await getDb().insert(schema.approvals).values([
    { id: "apr_stall_remind", agentId: agents.busy, runId: "run_stall_busy", stepId: "s2", summary: "Pay the invoice", source: "mcp", status: "pending", createdAt: minutes(62), expiresAt: later },
    { id: "apr_stall_fresh", agentId: agents.busy, runId: "run_stall_busy", summary: "Send the email", source: "mcp", status: "pending", createdAt: minutes(20), expiresAt: later },
    { id: "apr_stall_chat_old", agentId: agents.busy, runId: null, summary: "Post in the channel", source: "mcp", status: "pending", createdAt: minutes(62), expiresAt: later },
  ]);
  const sent: { to: string; text: string }[] = [];
  const send = async (to: { email: string }, text: string) => {
    sent.push({ to: to.email, text });
    return { ok: true };
  };
  const approvals = new Approvals({} as never);
  await approvals.remind(Date.now(), send as never);
  await approvals.remind(Date.now(), send as never);
  assert.equal(sent.filter((line) => /Pay the invoice/.test(line.text)).length, 1);
  assert.equal(sent.some((line) => /Send the email|Post in the channel/.test(line.text)), false);
  const reminder = sent.find((line) => /Pay the invoice/.test(line.text))!;
  assert.equal(reminder.to, "stall-owner@test.local");
  assert.match(reminder.text, /still waiting for your answer, and the task stays paused until you answer: "Pay the invoice"[\s\S]*\/waiting\|Answer now>[\s\S]*\/runs\/run_stall_busy\|See the task>/);
  await getDb().delete(schema.approvals).where(inArray(schema.approvals.id, ["apr_stall_remind", "apr_stall_fresh", "apr_stall_chat_old"]));
});
