import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { AMOUNT_LABEL, argsSubject, describeRule, findViolation, looksIrreversible, type OwnerRule, type RuleViolation } from "@understudy/protocol";
import { CDP_ENDPOINT } from "./browser.ts";
import { openGatekeeper, requestOwnerApproval, type McpSession } from "./gatekeeper-client.ts";
import { openRequestGate, type GatedRequest, type RequestGate } from "./request-gate.ts";
import { readTurnState, turnStateFile, type TurnState } from "./turn-state.ts";
import { readRules, rulesFile } from "./rules-store.ts";
import { openVault } from "./vault.ts";

export const HIDDEN_TOOLS = new Set<string>();

export type ElementInfo = {
  tag: string;
  type: string;
  role: string;
  name: string;
  label?: string;
  isSubmit: boolean;
  inForm: boolean;
  editable: boolean;
  url: string;
  fields: { label: string; value: string }[];
};

export type StepApproval = { runId: string; stepId: string; summary: string; until: number };

export type Verdict = { kind: "pass"; coveredBy?: StepApproval } | { kind: "block"; reason: string } | { kind: "ask"; summary: string; stepId?: string; fields: { label: string; value: string }[] };

export const ASK_FIRST_TOOL = "browser_ask_first";

export const STEP_APPROVAL_MS = 5 * 60 * 1000;

export const DIALOG_FOLLOW_UP_MS = 60 * 1000;

export const ASK_FIRST_TOOL_SPEC = {
  name: ASK_FIRST_TOOL,
  title: "Ask the owner before an ask-first step",
  description:
    'Before an [ASK FIRST] step of a task run, ask your owner to approve exactly what you are about to do, and wait for the answer. stepId: the id of the step in the run\'s step list. summary: one sentence naming the action and the exact item, like: Remove "Dom Casmurro" (ISBN 9788535910663) from the collection. fields: optional details the owner should see, such as values you will type, amounts or rows. Returns approved or denied. Once approved, do exactly that now; the browser does not ask again while you do it. Ask again for every item: an approval never covers the next one. If denied, skip that item and report it.',
  inputSchema: {
    type: "object",
    properties: {
      stepId: { type: "string", maxLength: 100 },
      summary: { type: "string", maxLength: 480 },
      fields: { type: "array", maxItems: 10, items: { type: "object", properties: { label: { type: "string", maxLength: 200 }, value: { type: "string", maxLength: 2000 } }, required: ["label", "value"] } },
    },
    required: ["stepId", "summary"],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

export type AskFirstPlan = { kind: "answer"; text: string; isError: boolean } | { kind: "ask"; summary: string; stepId: string; fields: { label: string; value: string }[] };

export function askFirstPlan(state: TurnState, args: Record<string, unknown>): AskFirstPlan {
  if (state.mode !== "run") return { kind: "answer", isError: true, text: `not asked: ${ASK_FIRST_TOOL} is only for [ASK FIRST] steps of a task run. Outside a run, the browser asks your owner by itself when you submit or send something; for anything else use request_approval.` };
  if (state.approvalsRequired === false) return { kind: "answer", isError: false, text: "approved: this run goes without approvals, so just do the step." };
  const stepId = String(args.stepId ?? "").trim();
  const step = (state.askSteps ?? []).find((candidate) => candidate.id === stepId);
  if (!step) return { kind: "answer", isError: true, text: `not asked: "${stepId.slice(0, 100)}" is not an [ASK FIRST] step of this run. Its ask-first steps are: ${(state.askSteps ?? []).map((candidate) => candidate.id).join(", ") || "none"}.` };
  const summary = String(args.summary ?? "").trim().replace(/\s+/g, " ").slice(0, 480);
  if (!summary) return { kind: "answer", isError: true, text: "not asked: summary must say exactly what you will do and to which item." };
  const extra = Array.isArray(args.fields) ? (args.fields as { label?: unknown; value?: unknown }[]).slice(0, 10).map((field) => ({ label: String(field?.label ?? "").slice(0, 200), value: String(field?.value ?? "").slice(0, 2000) })).filter((field) => field.label) : [];
  return { kind: "ask", summary, stepId: step.id, fields: [{ label: "Step", value: step.text }, ...extra] };
}

export function coveringApproval(approval: StepApproval | null | undefined, state: TurnState, now = Date.now()): StepApproval | null {
  if (!approval || state.mode !== "run" || !state.runId || state.runId !== approval.runId || now > approval.until) return null;
  return approval;
}

export type PageDialog = { type: string; message: string };

export function pendingDialog(text: string): PageDialog | null {
  const found = [...text.matchAll(/\["(alert|confirm|prompt|beforeunload)" dialog with message "([\s\S]*?)"\]: can be handled/g)].pop();
  return found ? { type: found[1], message: found[2].slice(0, 300) } : null;
}

export function dialogReason(args: Record<string, unknown>, dialog: PageDialog | null): string | null {
  if (args.accept !== true) return null;
  if (dialog?.type === "alert" || dialog?.type === "beforeunload") return null;
  const what = dialog ? `confirm the page's question "${dialog.message}"` : "confirm a question the page asked";
  return typeof args.promptText === "string" && args.promptText ? `${what} with "${args.promptText.slice(0, 120)}"` : what;
}

export const ELEMENT_INFO = `(el) => {
  const element = el || document.activeElement || document.body;
  const form = element.closest ? element.closest("form") : null;
  const tag = (element.tagName || "").toLowerCase();
  const type = (element.getAttribute && element.getAttribute("type") || "").toLowerCase();
  const role = (element.getAttribute && element.getAttribute("role") || "").toLowerCase();
  const name = ((element.getAttribute && element.getAttribute("aria-label")) || element.innerText || element.value || element.title || "").trim().replace(/\\s+/g, " ").slice(0, 200);
  const label = ((element.labels && element.labels[0] && element.labels[0].innerText) || (element.getAttribute && (element.getAttribute("aria-label") || element.getAttribute("placeholder") || element.getAttribute("name") || element.id)) || "").trim().replace(/\s+/g, " ").slice(0, 120);
  const isSubmit = (tag === "button" && (type === "" || type === "submit") && !!form) || (tag === "input" && (type === "submit" || type === "image"));
  const editable = tag === "textarea" || element.isContentEditable === true;
  const fields = form ? Array.from(form.elements).filter((f) => (f.name || f.id) && f.type !== "hidden" && f.type !== "submit" && f.tagName !== "BUTTON").slice(0, 12).map((f) => ({
    label: ((f.labels && f.labels[0] && f.labels[0].innerText) || f.getAttribute("aria-label") || f.getAttribute("placeholder") || f.name || f.id || "").trim().slice(0, 80),
    value: f.type === "password" ? "••••••" : (f.type === "checkbox" || f.type === "radio") ? String(f.checked) : String(f.value == null ? "" : f.value).slice(0, 300),
  })) : [];
  return { tag, type, role, name, label, isSubmit, inForm: !!form, editable, url: location.href, fields };
}`;

export function parseEvaluateResult(text: string): ElementInfo | null {
  const body = text.match(/### Result\s*\n([\s\S]*?)(?:\n### |$)/)?.[1]?.trim();
  if (!body) return null;
  try {
    const value = JSON.parse(body);
    return value && typeof value.tag === "string" ? value : null;
  } catch {
    return null;
  }
}

export const UNKNOWN_ELEMENT: ElementInfo = { tag: "unknown", type: "", role: "", name: "", isSubmit: false, inForm: false, editable: false, url: "", fields: [] };

export function commitReason(tool: string, args: Record<string, unknown>, info: ElementInfo | null): string | null {
  if (!info) {
    if (tool === "browser_press_key" && String(args.key) !== "Enter") return null;
    if (tool === "browser_type" && args.submit !== true) return null;
    return "an action on an element the computer could not inspect";
  }
  const loginForm = info.isSubmit && info.fields.length <= 3 && info.fields.some((field) => field.value === "••••••") && !looksIrreversible(info.name);
  if (loginForm) return null;
  if (tool === "browser_click") {
    if (info.isSubmit) return `submit "${info.name || "form"}"`;
    if (looksIrreversible(info.name)) return `click "${info.name}"`;
    return null;
  }
  if (tool === "browser_press_key") {
    if (String(args.key) !== "Enter") return null;
    if (info.isSubmit) return `submit "${info.name || "form"}"`;
    if (info.inForm && info.tag === "input") return "press Enter in a form";
    if ((info.tag === "button" || info.tag === "a" || info.role === "button" || info.role === "link") && looksIrreversible(info.name)) return `press Enter on "${info.name}"`;
    return null;
  }
  if (tool === "browser_type" && args.submit === true && !info.editable) return "type and submit";
  return null;
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/).filter((word) => word.length > 2));
}

export function matchStep(name: string, steps: { id: string; text: string }[]): { id: string; text: string } | undefined {
  const target = words(name);
  let best: { id: string; text: string } | undefined;
  let bestScore = 0;
  for (const step of steps) {
    const score = [...words(step.text)].filter((word) => target.has(word)).length;
    if (score > bestScore) {
      best = step;
      bestScore = score;
    }
  }
  return best;
}

export function decide(state: TurnState, reason: string | null, info: ElementInfo | null, approval: StepApproval | null = null): Verdict {
  if (!reason || !info) return { kind: "pass" };
  if (state.mode === "recipe") return { kind: "block", reason: "blocked: while learning a task nothing is submitted or sent" };
  if (state.mode === "run" && state.approvalsRequired === false) return { kind: "pass" };
  const cover = coveringApproval(approval, state);
  if (cover) return { kind: "pass", coveredBy: cover };
  let host = info.url;
  try {
    host = new URL(info.url).host;
  } catch {}
  const step = matchStep(info.name, state.askSteps ?? []);
  return {
    kind: "ask",
    summary: `${reason.charAt(0).toUpperCase()}${reason.slice(1)}${host ? ` on ${host}` : ""}`.slice(0, 480),
    stepId: step?.id,
    fields: [
      { label: "Step", value: step ? step.text : state.mode === "run" ? "Not a step of the recipe" : "Asked in chat" },
      { label: "Page", value: info.url.slice(0, 300) },
      ...info.fields.filter((field) => field.label),
    ].slice(0, 14),
  };
}

export const SCRIPT_TOOLS = new Set(["browser_evaluate", "browser_run_code", "browser_run_code_unsafe"]);

export const COMMIT_TOOLS = new Set(["browser_click", "browser_press_key", "browser_type", "browser_handle_dialog"]);

export const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const SCRIPT_GRACE_MS = 1500;

export type ScriptVerdict = Verdict | { kind: "rule"; violation: RuleViolation };

export function scriptRequestSubject(request: Pick<GatedRequest, "url" | "body" | "pageUrl">): { urls: string[]; texts: string[]; amounts: string[] } {
  const urls = [request.url, request.pageUrl].filter(Boolean);
  const body = (request.body ?? "").slice(0, 20000);
  if (!body) return { urls, texts: [], amounts: [] };
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    if (/^[^\s=&]+=[^&\s]*(&[^\s=&]+=[^&\s]*)*$/.test(body.trim())) parsed = Object.fromEntries(new URLSearchParams(body.trim()));
  }
  const inner = parsed && typeof parsed === "object" ? argsSubject(parsed) : { urls: [], texts: [], amounts: [] };
  return { urls: [...urls, ...(inner.urls ?? [])], texts: [body, ...(inner.texts ?? [])], amounts: inner.amounts ?? [] };
}

export function scriptRequestVerdict(state: TurnState, rules: OwnerRule[], request: Pick<GatedRequest, "method" | "url" | "body" | "pageUrl">, stepHint = "", approval: StepApproval | null = null): ScriptVerdict {
  const method = request.method.toUpperCase();
  if (SAFE_METHODS.has(method)) return { kind: "pass" };
  const violation = rules.length ? findViolation(rules, scriptRequestSubject(request)) : null;
  if (violation) return { kind: "rule", violation };
  if (state.mode === "recipe") return { kind: "block", reason: "blocked: while learning a task nothing is submitted or sent, and a script just tried to send a request" };
  if (state.mode === "run" && state.approvalsRequired === false) return { kind: "pass" };
  const cover = coveringApproval(approval, state);
  if (cover) return { kind: "pass", coveredBy: cover };
  let host = request.url;
  try {
    host = new URL(request.url).host;
  } catch {}
  const step = stepHint ? matchStep(stepHint, state.askSteps ?? []) : undefined;
  return {
    kind: "ask",
    summary: `Script sent a ${method} to ${host}`.slice(0, 480),
    stepId: step?.id,
    fields: [
      { label: "Step", value: step ? step.text : state.mode === "run" ? "Not a step of the recipe" : "Asked in chat" },
      { label: "Page", value: (request.pageUrl || "unknown").slice(0, 300) },
      { label: "Request", value: `${method} ${request.url}`.slice(0, 300) },
      ...(request.body ? [{ label: "Body", value: request.body.slice(0, 300) }] : []),
    ],
  };
}

export const RECIPIENT_LABEL = /\b(to|cc|bcc|recipients?|send to|forward to|share with|invite|para|destinat\w*|copia)\b/i;

export const RULE_CHECKED_TOOLS = new Set(["browser_navigate", "browser_tabs", "browser_type", "browser_fill_form", "browser_select_option", "browser_click", "browser_press_key"]);

export function ruleCheck(rules: OwnerRule[], tool: string, args: Record<string, unknown>, info: ElementInfo | null, committing: boolean): RuleViolation | null {
  if (!rules.length) return null;
  const urls: string[] = [];
  const texts: string[] = [];
  const amounts: string[] = [];
  const amountLike = (label: string) => AMOUNT_LABEL.test(label);
  const recipientLike = (label: string) => RECIPIENT_LABEL.test(label);
  if (tool === "browser_navigate" && typeof args.url === "string") urls.push(args.url);
  if (tool === "browser_tabs" && typeof args.url === "string") urls.push(args.url);
  if (info?.url) urls.push(info.url);
  if (tool === "browser_type" && typeof args.text === "string") {
    const label = `${info?.label ?? ""} ${String(args.element ?? "")}`;
    if (recipientLike(label) || info?.editable) texts.push(args.text);
    if (amountLike(label)) amounts.push(args.text);
  }
  if (tool === "browser_fill_form" && Array.isArray(args.fields)) {
    for (const field of args.fields.slice(0, 100) as { name?: unknown; value?: unknown }[]) {
      const value = String(field?.value ?? "");
      if (recipientLike(String(field?.name ?? ""))) texts.push(value);
      if (amountLike(String(field?.name ?? ""))) amounts.push(value);
    }
  }
  if (tool === "browser_select_option" && Array.isArray(args.values)) {
    const values = args.values.map(String);
    if (recipientLike(`${info?.label ?? ""} ${String(args.element ?? "")}`)) texts.push(...values);
    if (amountLike(`${info?.label ?? ""} ${String(args.element ?? "")}`)) amounts.push(...values);
  }
  if (committing && info) {
    texts.push(info.name, ...info.fields.map((field) => field.value));
    amounts.push(...info.fields.filter((field) => amountLike(field.label)).map((field) => field.value));
    if (amountLike(info.name)) amounts.push(info.name);
  }
  return findViolation(rules, { urls, texts, amounts });
}

export function ruleBlockText(violation: RuleViolation): string {
  return `blocked by your owner's rule "${describeRule(violation.rule)}": ${violation.reason}. Do not try another way; stop and tell your owner.`;
}

export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    for (const form of new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)])) {
      out = out.split(form).join("••••••");
    }
  }
  return out;
}

export function notifyGuardSocket(path: string, event: Record<string, unknown>, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => socket.destroy(), timeoutMs);
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.end(`${JSON.stringify(event)}\n`);
  });
}

type Rpc = { jsonrpc: "2.0"; id?: string | number; method?: string; params?: any; result?: any; error?: any };

async function serve() {
  const home = process.env.HOME || "/home/agent";
  const stateFile = process.env.UNDERSTUDY_TURN_FILE || turnStateFile(home);
  const serverUrl = process.env.UNDERSTUDY_SERVER_URL || "";
  const token = process.env.AGENT_TOKEN || "";
  const vault = openVault(home);
  const secrets = () => vault.list().flatMap((entry) => [vault.reveal(entry.name)?.secret ?? ""]);
  const child = spawn(process.env.PLAYWRIGHT_MCP_BIN || "playwright-mcp", ["--cdp-endpoint", CDP_ENDPOINT], { stdio: ["pipe", "pipe", "inherit"] });
  const toBrain = (message: Rpc) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const toChild = (message: Rpc) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const own = new Map<string, (message: Rpc) => void>();
  const pendingResults = new Map<string | number, (message: Rpc) => Rpc | Promise<Rpc>>();
  let next = 0;
  let gatekeeper: Promise<McpSession> | null = null;
  let stepApproval: StepApproval | null = null;
  let lastApprovedAt = 0;
  let dialog: PageDialog | null = null;

  const notifyMain = (event: Record<string, unknown>) => notifyGuardSocket(process.env.UNDERSTUDY_GUARD_SOCKET || `${home}/.understudy/guard.sock`, event);

  const childCall = (name: string, args: Record<string, unknown>) =>
    new Promise<Rpc>((resolve) => {
      const id = `guard-${++next}`;
      own.set(id, resolve);
      toChild({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    });

  const elementInfo = async (target?: unknown): Promise<ElementInfo | null> => {
    const reply = await childCall("browser_evaluate", target ? { function: ELEMENT_INFO, target, element: "element the agent is acting on" } : { function: ELEMENT_INFO.replace("(el) =>", "() =>").replace("el || document.activeElement", "document.activeElement") });
    const text: string = reply.result?.content?.map((part: { text?: string }) => part.text ?? "").join("\n") ?? "";
    return parseEvaluateResult(text);
  };

  const textResult = (id: Rpc["id"], text: string, isError = true): Rpc => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError } });

  const askOwner = async (verdict: { summary: string; stepId?: string; fields: { label: string; value: string }[] }, state: TurnState): Promise<{ approved: boolean; text: string; requestId?: string }> => {
    if (!serverUrl || !token) return { approved: false, text: "no gatekeeper configured" };
    gatekeeper ??= openGatekeeper(serverUrl, token);
    const session = await gatekeeper;
    await notifyMain({ event: "waiting", summary: verdict.summary });
    try {
      const answer = await requestOwnerApproval(session, { summary: verdict.summary, fields: verdict.fields, runId: state.runId, stepId: verdict.stepId });
      if (answer.approved) lastApprovedAt = Date.now();
      return answer;
    } finally {
      await notifyMain({ event: "resumed" });
    }
  };

  const coveredSuffix = (cover: StepApproval) => ` (covered by the owner's approval of step ${cover.stepId}: "${cover.summary}")`;

  const askFirst = async (message: Rpc, args: Record<string, unknown>) => {
    const state = readTurnState(stateFile);
    const plan = askFirstPlan(state, args);
    if (plan.kind === "answer") return toBrain(textResult(message.id, plan.text, plan.isError));
    stepApproval = null;
    const answer = await askOwner(plan, state).catch((error: Error) => ({ approved: false, text: error.message, requestId: undefined }));
    if (!answer.approved) return toBrain(textResult(message.id, `denied: the owner did not approve "${plan.summary}" (${answer.text}). Do not do it and do not try another way; skip this item and report it.`, false));
    stepApproval = { runId: state.runId!, stepId: plan.stepId, summary: plan.summary, until: Date.now() + STEP_APPROVAL_MS };
    return toBrain(textResult(message.id, `approved: do exactly this now: "${plan.summary}". The browser does not ask again while you do it. For the next item, call ${ASK_FIRST_TOOL} again.${answer.requestId ? ` [requestId: ${answer.requestId}]` : ""}`, false));
  };

  const gatedScript = async (message: Rpc, args: Record<string, unknown>, rules: OwnerRule[]) => {
    const state = readTurnState(stateFile);
    const notes: string[] = [];
    const pending = new Set<Promise<boolean>>();
    let blocked = false;
    let denied = false;
    let seen = 0;
    let asking: Promise<unknown> = Promise.resolve();
    const stepHint = String(args.element ?? "");
    const judge = async (request: GatedRequest): Promise<boolean> => {
      const cleaned = { ...request, body: request.body === undefined ? undefined : redactSecrets(request.body, secrets()) };
      const verdict = scriptRequestVerdict(state, rules, cleaned, stepHint, stepApproval);
      if (verdict.kind === "pass") {
        if (verdict.coveredBy) notes.push(`${request.method.toUpperCase()} ${cleaned.url.slice(0, 200)}${coveredSuffix(verdict.coveredBy)}`);
        return true;
      }
      if (verdict.kind === "rule") {
        blocked = true;
        await notifyMain({ event: "rule_blocked", ruleId: verdict.violation.rule.id, rule: describeRule(verdict.violation.rule), detail: verdict.violation.reason });
        notes.push(ruleBlockText(verdict.violation));
        return false;
      }
      if (verdict.kind === "block") {
        blocked = true;
        notes.push(verdict.reason);
        return false;
      }
      const turn = asking.then(async () => {
        if (denied) return false;
        const answer = await askOwner(verdict, state).catch((error: Error) => ({ approved: false, text: error.message, requestId: undefined }));
        if (!answer.approved) {
          denied = true;
          notes.push(`blocked: needs approval. The owner did not approve "${verdict.summary}" (${answer.text}), so the request failed. Do not try another way; stop and report.`);
          return false;
        }
        notes.push(`${verdict.summary} (approved by the owner${answer.requestId ? ` [requestId: ${answer.requestId}]` : ""})`);
        return true;
      });
      asking = turn.catch(() => {});
      const approved = await turn;
      if (!approved) blocked = true;
      return approved;
    };
    const onRequest = (request: GatedRequest) => {
      if (SAFE_METHODS.has(request.method.toUpperCase())) return Promise.resolve(true);
      seen++;
      const work = judge(request).catch(() => false);
      pending.add(work);
      void work.finally(() => pending.delete(work));
      return work;
    };
    let gate: RequestGate;
    try {
      gate = await openRequestGate(onRequest);
    } catch (error) {
      return toBrain(textResult(message.id, `blocked: the computer could not watch what this script would send (${(error as Error).message}), so it did not run it. Use the browser tools (click, type, fill) instead.`));
    }
    pendingResults.set(message.id!, async (reply) => {
      for (let round = 0; round < 5; round++) {
        const before = seen;
        await new Promise((resolve) => setTimeout(resolve, SCRIPT_GRACE_MS));
        await Promise.all([...pending]);
        if (seen === before) break;
      }
      await gate.close();
      if (!notes.length) return reply;
      const text = `Requests this script tried to send:\n${notes.join("\n")}`;
      if (!reply.result?.content) return textResult(reply.id, text);
      reply.result.content.push({ type: "text", text });
      if (blocked) reply.result.isError = true;
      return reply;
    });
    toChild(message);
  };

  const guarded = async (message: Rpc) => {
    const tool = String(message.params?.name ?? "");
    const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
    if (HIDDEN_TOOLS.has(tool)) return toBrain(textResult(message.id, `${tool} is not available to the agent.`));
    const rules = readRules(rulesFile(home));
    const blockForRule = async (violation: RuleViolation) => {
      await notifyMain({ event: "rule_blocked", ruleId: violation.rule.id, rule: describeRule(violation.rule), detail: violation.reason });
      return toBrain(textResult(message.id, ruleBlockText(violation)));
    };
    if (tool === ASK_FIRST_TOOL) return askFirst(message, args);
    if (SCRIPT_TOOLS.has(tool)) return gatedScript(message, args, rules);
    if (!COMMIT_TOOLS.has(tool)) {
      if (rules.length && RULE_CHECKED_TOOLS.has(tool)) {
        const pageInfo = tool === "browser_navigate" || tool === "browser_tabs" ? null : await elementInfo(args.target ?? undefined);
        const violation = ruleCheck(rules, tool, args, pageInfo, false);
        if (violation) return blockForRule(violation);
      }
      return toChild(message);
    }
    const passWith = (suffix: string) => {
      if (suffix)
        pendingResults.set(message.id!, (reply) => {
          if (reply.result?.content?.[0]?.type === "text") reply.result.content[0].text += suffix;
          return reply;
        });
      toChild(message);
    };
    const asDialog = tool === "browser_handle_dialog";
    const shown = dialog;
    if (asDialog) dialog = null;
    const info = asDialog ? { ...UNKNOWN_ELEMENT, name: shown?.message ?? "" } : await elementInfo(tool === "browser_press_key" ? undefined : args.target);
    const reason = asDialog ? dialogReason(args, shown) : commitReason(tool, args, info);
    const violation = asDialog ? null : ruleCheck(rules, tool, args, info, Boolean(reason));
    if (violation) return blockForRule(violation);
    const state = readTurnState(stateFile);
    if (asDialog && reason && Date.now() - lastApprovedAt < DIALOG_FOLLOW_UP_MS) {
      lastApprovedAt = 0;
      return passWith(" (part of the action the owner just approved)");
    }
    const verdict = decide(state, reason, info ?? { ...UNKNOWN_ELEMENT, name: String(args.element ?? "") }, stepApproval);
    if (verdict.kind === "pass") return passWith(verdict.coveredBy ? coveredSuffix(verdict.coveredBy) : "");
    if (verdict.kind === "block") return toBrain(textResult(message.id, verdict.reason));
    const answer = await askOwner(verdict, state).catch((error: Error) => ({ approved: false, text: error.message, requestId: undefined }));
    if (!answer.approved) {
      return toBrain(textResult(message.id, `blocked: needs approval. The owner did not approve "${verdict.summary}" (${answer.text}). Do not try another way; stop and report.`));
    }
    passWith(` (approved by the owner${answer.requestId ? ` [requestId: ${answer.requestId}]` : ""})`);
  };

  createInterface({ input: child.stdout }).on("line", (line) => {
    let message: Rpc;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message.id === "string" && own.has(message.id)) {
      own.get(message.id)!(message);
      own.delete(message.id);
      return;
    }
    if (message.result?.tools) message.result.tools = [...message.result.tools.filter((tool: { name: string }) => !HIDDEN_TOOLS.has(tool.name) && tool.name !== ASK_FIRST_TOOL), ASK_FIRST_TOOL_SPEC];
    const shownDialog = Array.isArray(message.result?.content) ? pendingDialog(message.result.content.map((part: { text?: string }) => part.text ?? "").join("\n")) : null;
    if (shownDialog) dialog = shownDialog;
    const hook = message.id !== undefined ? pendingResults.get(message.id) : undefined;
    if (!hook) return deliver(message);
    pendingResults.delete(message.id!);
    void Promise.resolve()
      .then(() => hook(message))
      .then(deliver, (error: Error) => deliver(textResult(message.id, `blocked: ${error.message}`)));
  });

  const deliver = (message: Rpc) => {
    const list = secrets();
    if (!list.length) return toBrain(message);
    try {
      toBrain(JSON.parse(redactSecrets(JSON.stringify(message), list)));
    } catch {
      if (message.id !== undefined) toBrain(textResult(message.id, "The result was withheld because it could not be cleaned of saved secrets."));
    }
  };

  createInterface({ input: process.stdin }).on("line", (line) => {
    let message: Rpc;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method === "tools/call") {
      void guarded(message).catch((error: Error) => toBrain(textResult(message.id, `blocked: ${error.message}`)));
      return;
    }
    toChild(message);
  });

  process.stdin.on("end", () => child.kill());
  child.on("exit", (code) => process.exit(code ?? 0));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  void serve();
}
