import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ComputerApprovalPolicy } from "@understudy/protocol";
import { createAgent } from "./agent.ts";
import { approvalPolicyFile, approvedSitesFile, DEFAULT_COMPUTER_POLICY, readApprovalPolicy, rememberApprovedSite, sitesApprovedIn, writeApprovalPolicy } from "./approval-policy-store.ts";
import type { TurnRequest } from "./brain.ts";
import { decide, guardMode, memorySites, passedWithoutNote, scriptAsks, scriptRequestVerdict, type ElementInfo } from "./browser-guard.ts";
import { createMemory } from "./memory.ts";
import { readTurnState, type TurnState } from "./turn-state.ts";

const element = (over: Partial<ElementInfo> = {}): ElementInfo => ({ tag: "button", type: "", role: "", name: "Post", isSubmit: true, inForm: true, editable: false, url: "https://www.social.test/feed", fields: [], ...over });
const policy = (over: Partial<ComputerApprovalPolicy> = {}): ComputerApprovalPolicy => ({ ...DEFAULT_COMPUTER_POLICY, ...over });
const post = (url: string) => ({ method: "POST", url, body: "{}", pageUrl: "https://www.social.test/feed" });
const chat: TurnState = { mode: "chat", conversation: "chat:owner:2026-01-05" };
const fromSomeoneElse: TurnState = { ...chat, untrusted: true };

test("on-miss, the default, asks for a committing action unless the owner always allows that site", () => {
  const asked = decide(chat, 'submit "Post"', element(), null, policy());
  assert.equal(asked.kind, "ask");
  assert.equal(asked.kind === "ask" && asked.site, "social.test");
  assert.deepEqual(decide(chat, 'submit "Post"', element(), null, policy({ hosts: ["social.test"] })), { kind: "pass", without: "your owner always allows social.test" });
  assert.equal(decide(chat, 'submit "Post"', element({ url: "https://social.test.evil.example/" }), null, policy({ hosts: ["social.test"] })).kind, "ask");
  assert.equal(decide(chat, 'submit "Post"', element(), null, policy({ mode: "auto", hosts: ["social.test"] })).kind, "pass");
});

test("always asks for every committing action, even on an always-allowed site, and offers no site to remember", () => {
  const asked = decide(chat, 'submit "Post"', element(), null, policy({ mode: "always", hosts: ["social.test"] }));
  assert.equal(asked.kind, "ask");
  assert.equal(asked.kind === "ask" && asked.site, undefined);
});

test("off lets the owner's own turns act without asking", () => {
  assert.deepEqual(decide(chat, 'submit "Post"', element(), null, policy({ mode: "off" })), { kind: "pass", without: "your owner lets you act without asking" });
  assert.deepEqual(scriptRequestVerdict(chat, [], post("https://www.social.test/api/like"), "", null, policy({ mode: "off" })), { kind: "pass", without: "your owner lets you act without asking" });
});

test("a turn from anyone but the owner and a webhook or handed-over run ask as before, ignoring the list; a run that must ask never drops below on-miss", () => {
  const off = policy({ mode: "off" });
  const listed = policy({ hosts: ["social.test"] });
  assert.equal(guardMode(fromSomeoneElse, off), "always");
  assert.equal(guardMode(fromSomeoneElse, listed), "always");
  assert.equal(decide(fromSomeoneElse, 'submit "Post"', element(), null, listed).kind, "ask");
  assert.equal(scriptRequestVerdict(fromSomeoneElse, [], post("https://www.social.test/api/like"), "", null, listed, ["social.test"]).kind, "ask");
  assert.equal(decide(fromSomeoneElse, 'submit "Post"', element(), null, off).kind, "ask");
  assert.equal(scriptRequestVerdict(fromSomeoneElse, [], post("https://www.social.test/api/like"), "", null, off).kind, "ask");
  const webhookRun: TurnState = { mode: "run", runId: "r1", approvalsRequired: true, untrusted: true, askSteps: [{ id: "s1", text: "Post the update" }], conversation: "run:r1" };
  assert.equal(decide(webhookRun, 'submit "Post"', element(), null, off).kind, "ask");
  const listedAsk = decide(webhookRun, 'submit "Post"', element(), null, listed);
  assert.equal(listedAsk.kind, "ask");
  assert.equal(listedAsk.kind === "ask" && listedAsk.site, undefined);
  assert.equal(scriptRequestVerdict(webhookRun, [], post("https://www.social.test/api/other"), "Post the update", null, listed, ["social.test"]).kind, "ask");
  assert.equal(scriptRequestVerdict(webhookRun, [], post("https://www.social.test/api/other"), "", null, listed, ["social.test"]).kind, "drop");
  const graduatedRun: TurnState = { mode: "run", runId: "r2", approvalsRequired: true, askSteps: [{ id: "s1", text: "Post the update" }], conversation: "run:r2" };
  assert.equal(guardMode(graduatedRun, off), "on-miss");
  assert.equal(decide({ ...graduatedRun, approvalsRequired: false }, 'submit "Post"', element(), null, policy()).kind, "pass");
  assert.equal(guardMode(fromSomeoneElse, policy({ mode: "always" })), "always");
});

test("rules the owner wrote and the no-send rule while learning hold in every mode", () => {
  const rules = [{ id: "site", kind: "blocked_site" as const, site: "gamble.test" }];
  const off = policy({ mode: "off", hosts: ["gamble.test"] });
  const ruled = scriptRequestVerdict(chat, rules, { ...post("https://gamble.test/bet"), pageUrl: "https://gamble.test/" }, "", null, off);
  assert.equal(ruled.kind === "rule" && ruled.violation.rule.id, "site");
  assert.equal(decide({ mode: "recipe" }, 'submit "Post"', element(), null, off).kind, "block");
  assert.equal(scriptRequestVerdict({ mode: "recipe" }, [], post("https://www.social.test/api/like"), "", null, off).kind, "block");
});

test("a script request asks once per site per conversation, and the list covers it for good", () => {
  const ask = scriptRequestVerdict(chat, [], post("https://www.social.test/voyager/api/abc123"), "", null, policy());
  assert.equal(ask.kind === "ask" && ask.site, "social.test");
  assert.deepEqual(scriptRequestVerdict(chat, [], post("https://www.social.test/voyager/api/zzz999"), "", null, policy(), ["social.test"]), { kind: "pass", without: "your owner approved social.test earlier in this conversation" });
  assert.equal(scriptRequestVerdict(chat, [], post("https://cdn.social.test/x"), "", null, policy(), ["social.test"]).kind, "ask");
  assert.deepEqual(scriptRequestVerdict(chat, [], post("https://cdn.social.test/x"), "", null, policy({ hosts: ["social.test"] })), { kind: "pass", without: "your owner always allows social.test" });
  const always = scriptRequestVerdict(chat, [], post("https://cdn.social.test/x"), "", null, policy({ mode: "always", hosts: ["social.test"] }), ["social.test"]);
  assert.equal(always.kind, "ask");
  assert.equal(always.kind === "ask" && always.site, undefined);
  const run: TurnState = { mode: "run", runId: "r1", approvalsRequired: true, askSteps: [{ id: "s1", text: "Like the newest posts" }], conversation: "run:r1" };
  assert.deepEqual(scriptRequestVerdict(run, [], post("https://www.social.test/a"), "like the newest posts", null, policy(), ["social.test"]), { kind: "pass", without: "your owner approved social.test earlier in this run" });
  assert.equal(scriptRequestVerdict(chat, [], { ...post("https://www.google-analytics.com/g/collect"), pageUrl: "https://shop.test/" }, "", null, policy()).kind, "drop");
  assert.deepEqual(passedWithoutNote([{ request: "POST social.test/a", why: "x" }, { request: "POST social.test/a", why: "x" }, { request: "POST shop.test/b", why: "y" }]), ["sent without asking (x): POST social.test/a ×2", "sent without asking (y): POST shop.test/b"]);
});

test("one approval covers a site across addresses and scripts of the same conversation, never the next one", async () => {
  const home = mkdtempSync(join(tmpdir(), "understudy-modes-"));
  const file = approvedSitesFile(home);
  const asked: string[] = [];
  const answer = async (verdict: { summary: string }) => (asked.push(verdict.summary), { approved: true, text: "approved" });
  const verdict = (url: string) => {
    const result = scriptRequestVerdict(chat, [], post(url), "", null, policy(), sitesApprovedIn(file, chat.conversation));
    assert.equal(result.kind, "ask");
    return result as Extract<typeof result, { kind: "ask" }>;
  };
  const sites = (conversation: string) => ({ has: (site: string) => sitesApprovedIn(file, conversation).includes(site), add: (site: string) => rememberApprovedSite(file, conversation, site) });
  const first = scriptAsks(answer, [], null, sites("chat:owner:2026-01-05"), "conversation");
  const burst = await Promise.all([first.request(verdict("https://www.social.test/a1"), "POST www.social.test/a1"), first.request(verdict("https://www.social.test/a2"), "POST www.social.test/a2")]);
  assert.deepEqual(burst, [true, true]);
  assert.equal(asked.length, 1);
  assert.equal(first.repeatNote(), "sent without asking again: POST www.social.test/a2. The owner approved the same site earlier in this conversation.");
  assert.deepEqual(sitesApprovedIn(file, "chat:owner:2026-01-05"), ["social.test"]);
  assert.equal(scriptRequestVerdict(chat, [], post("https://www.social.test/a3"), "", null, policy(), sitesApprovedIn(file, chat.conversation)).kind, "pass");
  assert.deepEqual(sitesApprovedIn(file, "chat:owner:2026-01-06"), []);
  assert.deepEqual(sitesApprovedIn(file, undefined), []);
  const denied = scriptAsks(async () => ({ approved: false, text: "denied" }), [], null, memorySites());
  assert.equal(await denied.request(verdict("https://other.test/x"), "POST other.test/x"), false);
});

test("the policy and the approved sites live in private files, and a broken file means today's behavior", () => {
  const home = mkdtempSync(join(tmpdir(), "understudy-modes-"));
  const file = approvalPolicyFile(home);
  assert.deepEqual(readApprovalPolicy(file), DEFAULT_COMPUTER_POLICY);
  writeApprovalPolicy(file, { mode: "off", hosts: ["social.test"], ownerId: "user_1" });
  assert.deepEqual(readApprovalPolicy(file), { mode: "off", hosts: ["social.test"], ownerId: "user_1" });
  writeFileSync(file, '{"mode":"never-ever","hosts":[]}');
  assert.deepEqual(readApprovalPolicy(file), DEFAULT_COMPUTER_POLICY);
  const sites = approvedSitesFile(home);
  rememberApprovedSite(sites, "c1", "https://WWW.Social.test/x");
  rememberApprovedSite(sites, "c1", "not a host");
  assert.deepEqual(sitesApprovedIn(sites, "c1"), ["social.test"]);
  rememberApprovedSite(sites, "c2", "shop.test");
  assert.deepEqual(sitesApprovedIn(sites, "c1"), []);
  assert.deepEqual(sitesApprovedIn(sites, "c2"), ["shop.test"]);
});

test("the turn records whose it is and which conversation it belongs to", async () => {
  const home = mkdtempSync(join(tmpdir(), "understudy-modes-"));
  const turnFile = join(home, ".understudy", "turn.json");
  const policyFile = approvalPolicyFile(home);
  mkdirSync(join(home, ".understudy"), { recursive: true });
  writeApprovalPolicy(policyFile, { mode: "off", hosts: [], ownerId: "owner_1" });
  const states: TurnState[] = [];
  const runTurn = (_config: unknown, request: TurnRequest) => {
    states.push(readTurnState(turnFile));
    return { done: Promise.resolve({ ok: true, text: 'RESULT {"ok": true, "summary": "s"}', sessionId: `s${states.length}` }), cancel: () => {} };
  };
  const agent = createAgent({
    config: { home, workDir: join(home, "work"), serverUrl: "http://x", token: "t" },
    memory: createMemory(home),
    settingsFile: join(home, ".understudy", "settings.json"),
    send: () => true,
    runTurn: runTurn as never,
    turnFile,
    approvalPolicyFile: policyFile,
    today: () => "2026-01-05",
  });
  const settle = async () => {
    for (let index = 0; index < 20; index++) await new Promise((resolve) => setImmediate(resolve));
  };
  agent.enqueue({ kind: "chat", text: "hi", from: "Owner" });
  await settle();
  agent.enqueue({ kind: "chat", text: "hi", from: "Owner", askedBy: "owner_1" });
  await settle();
  agent.enqueue({ kind: "chat", text: "hi", from: "Teammate", askedBy: "member_2" });
  await settle();
  agent.enqueue({ kind: "chat", text: "hi", from: "Bot", fromAgent: { id: "agent_9", name: "Bot" } });
  await settle();
  agent.enqueue({ kind: "chat", text: "check", from: "Owner", followup: { id: "f1", bookedAt: 1, emptyWakes: 0 } });
  await settle();
  agent.enqueue({ kind: "room", roomId: "room_1", prompt: "hi" });
  await settle();
  const recipe = { title: "T", trigger: "x", steps: [{ id: "s1", text: "Send", mode: "ask" as const }], questions: [], askFirstRuns: 3 };
  agent.enqueue({ kind: "run", runId: "r1", recipe, approvalsRequired: false });
  await settle();
  const seen = states.filter((state) => state.mode !== "idle").map((state) => ({ untrusted: state.untrusted === true, conversation: state.conversation }));
  assert.deepEqual(seen.slice(0, 7), [
    { untrusted: false, conversation: "chat:owner:2026-01-05" },
    { untrusted: false, conversation: "chat:owner_1:2026-01-05" },
    { untrusted: true, conversation: "chat:member_2:2026-01-05" },
    { untrusted: true, conversation: "chat:agent:agent_9:2026-01-05" },
    { untrusted: true, conversation: "chat:followup:f1:2026-01-05" },
    { untrusted: true, conversation: "room:room_1:2026-01-05" },
    { untrusted: false, conversation: "run:r1" },
  ]);
});

test("a sign-in, code, password, payment, delete or send request asks every time, even on a site approved earlier in the conversation", async () => {
  const { asksEveryTime } = await import("./browser-guard.ts");
  for (const url of ["https://books.test/api/totp/verify-code", "https://books.test/api/auth/google", "https://shop.test/checkout/confirm", "https://mail.test/api/send", "https://files.test/v1/delete", "https://site.test/signin/_/batchexecute", "not a url"]) assert.equal(asksEveryTime(url), true, url);
  for (const url of ["https://www.social.test/voyager/api/feed", "https://chat.test/u/1/api/list_members", "https://mail.test/sync/u/1/i/bv"]) assert.equal(asksEveryTime(url), false, url);
  const verify = scriptRequestVerdict(chat, [], { ...post("https://books.test/api/totp/verify-code"), body: '{"code":"000000"}' }, "", null, policy(), ["books.test"]);
  assert.equal(verify.kind, "ask");
  assert.equal(verify.kind === "ask" && verify.everyTime, true);
  assert.equal(verify.kind === "ask" && verify.site, undefined);
  assert.equal(scriptRequestVerdict(chat, [], post("https://books.test/api/totp/verify-code"), "", null, policy({ hosts: ["books.test"] })).kind, "ask");
  assert.equal(scriptRequestVerdict(chat, [], post("https://books.test/api/totp/verify-code"), "", null, policy({ mode: "always", hosts: ["books.test"] })).kind, "ask");
  assert.deepEqual(scriptRequestVerdict(chat, [], post("https://books.test/api/totp/verify-code"), "", null, policy({ mode: "off", hosts: ["books.test"] })), { kind: "pass", without: "your owner lets you act without asking" });
  assert.deepEqual(scriptRequestVerdict(chat, [], post("https://books.test/api/catalog/search"), "", null, policy({ hosts: ["books.test"] })), { kind: "pass", without: "your owner always allows books.test" });
  const asked: string[] = [];
  const asks = scriptAsks(async (ask) => (asked.push(ask.summary), { approved: true, text: "approved" }), [], null, memorySites());
  const read = scriptRequestVerdict(chat, [], post("https://books.test/api/catalog/search"), "", null, policy());
  assert.equal(read.kind, "ask");
  await asks.request(read as Extract<typeof read, { kind: "ask" }>, "POST books.test/api/catalog/search");
  await asks.request(verify as Extract<typeof verify, { kind: "ask" }>, "POST books.test/api/totp/verify-code");
  await asks.request(verify as Extract<typeof verify, { kind: "ask" }>, "POST books.test/api/totp/verify-code");
  assert.equal(asked.length, 2);
});

test("buying, deleting, changing permissions or creating an account asks even on an always-allowed site, unless the owner never wants to be asked", async () => {
  const { confirmsAlways } = await import("./browser-guard.ts");
  const listed = policy({ hosts: ["social.test"] });
  for (const [reason, name] of [['submit "Place order"', "Place order"], ['click "Delete account"', "Delete account"], ['click "Remove member"', "Remove member"], ['submit "Change permissions"', "Change permissions"], ['submit "Create account"', "Create account"], ['click "Excluir"', "Excluir"]]) {
    assert.equal(confirmsAlways(`${reason} ${name}`), true, name);
    const verdict = decide(chat, reason, element({ name }), null, listed);
    assert.equal(verdict.kind, "ask", name);
    assert.equal(verdict.kind === "ask" && verdict.site, undefined, name);
    assert.equal(decide(chat, reason, element({ name }), null, policy({ mode: "off", hosts: ["social.test"] })).kind, "pass", name);
  }
  assert.deepEqual(decide(chat, 'submit "Post"', element(), null, listed), { kind: "pass", without: "your owner always allows social.test" });
  assert.equal(confirmsAlways('submit "Post" Post'), false);
});

test("in a run, a script request outside the steps is dropped before any site shortcut", () => {
  const run: TurnState = { mode: "run", runId: "r9", approvalsRequired: true, askSteps: [{ id: "s1", text: "Post the update" }], conversation: "run:r9" };
  assert.equal(scriptRequestVerdict(run, [], post("https://www.social.test/api/other"), "", null, policy({ hosts: ["social.test"] }), ["social.test"]).kind, "drop");
  assert.equal(scriptRequestVerdict(run, [], post("https://www.social.test/api/other"), "", null, policy(), ["social.test"]).kind, "drop");
  assert.equal(scriptRequestVerdict(run, [], post("https://www.social.test/api/other"), "post the update", null, policy(), ["social.test"]).kind, "pass");
});

test("a bare public suffix or shared hosting domain is never a site to allow", () => {
  const ask = decide(chat, 'submit "Send"', element({ url: "https://www.gov.br/x" }), null, policy({ hosts: ["gov.br", "com"] }));
  assert.equal(ask.kind, "ask");
  assert.equal(ask.kind === "ask" && ask.site, "www.gov.br");
  assert.equal(decide(chat, 'submit "Send"', element({ url: "https://attacker.github.io/" }), null, policy({ hosts: ["github.io"] })).kind, "ask");
});
