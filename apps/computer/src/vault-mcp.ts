import { join } from "node:path";
import { createInterface } from "node:readline";
import { API_METHODS, callApi, type ApiCallDeps } from "./api-call.ts";
import { CDP_ENDPOINT } from "./browser.ts";
import { notifyGuardSocket } from "./browser-guard.ts";
import { cdpCall, cdpConnect, pageTargets } from "./cdp.ts";
import { openGatekeeper, requestOwnerApproval, type McpSession } from "./gatekeeper-client.ts";
import { readRules, rulesFile } from "./rules-store.ts";
import { readTurnState, turnStateFile } from "./turn-state.ts";
import { hostMatches, openVault, type CredentialInfo, type Vault } from "./vault.ts";

type Part = "username" | "secret";

export const VAULT_TOOLS = [
  {
    name: "list_credentials",
    description: "List the saved logins and API keys this agent may use (names, usernames and sites only; never secrets).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "call_api",
    description:
      "Call an HTTP API with a saved API key, without the key ever reaching you: the vault adds it to the request. url is a full https address on the key's site, or a path starting with / on that site. GET, HEAD and OPTIONS go straight through; calls that change something (POST, PUT, PATCH, DELETE) wait for your owner's approval first. Redirects are not followed. A body longer than 20 KB, binary content, or any call with saveAs is saved under ~/files/api and you get the path and the first part.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "the saved API key's name, from list_credentials" },
        method: { type: "string", enum: API_METHODS },
        url: { type: "string" },
        headers: { type: "object", additionalProperties: { type: "string" } },
        body: { description: "a string, or a JSON value sent as application/json" },
        saveAs: { type: "string", description: "file name to save the response body under ~/files/api" },
      },
      required: ["name", "url"],
    },
  },
  {
    name: "fill_credential",
    description:
      "Type a saved login into a field of the page that is open, without the value ever reaching you. part is username or secret (default secret). fieldSelector is a CSS selector or label=<visible label text>; leave it empty to pick the password field (for secret) or the field before it (for username). Refuses pages outside the credential's site.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        fieldSelector: { type: "string" },
        part: { type: "string", enum: ["username", "secret"] },
      },
      required: ["name"],
    },
  },
];

export function focusedKindScript(): string {
  return `(() => { const element = document.activeElement; if (!element || element.tagName !== "INPUT") return "other"; return (element.getAttribute("type") || "text").toLowerCase(); })()`;
}

export function fieldAccepts(part: "username" | "secret", kind: string): boolean {
  return part === "secret" ? kind === "password" : ["text", "email", "tel", "search"].includes(kind);
}

export function locateFieldScript(selector: string, part: Part): string {
  return `(() => {
  const selector = ${JSON.stringify(selector)};
  const part = ${JSON.stringify(part)};
  const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; };
  const fields = () => Array.from(document.querySelectorAll("input, textarea")).filter((e) => visible(e) && !e.disabled && !["hidden","submit","button","checkbox","radio"].includes(e.type));
  let element = null;
  if (selector.startsWith("label=")) {
    const wanted = selector.slice(6).trim().toLowerCase();
    element = fields().find((e) => {
      const texts = [e.getAttribute("aria-label"), e.getAttribute("placeholder"), e.getAttribute("name"), ...(e.labels ? Array.from(e.labels).map((l) => l.textContent) : [])];
      return texts.some((t) => t && t.trim().toLowerCase().includes(wanted));
    }) || null;
  } else if (selector) {
    try { element = document.querySelector(selector); } catch { return "bad-selector"; }
  } else {
    const all = fields();
    const password = all.find((e) => e.type === "password");
    element = part === "secret" ? password || null : (password ? all[all.indexOf(password) - 1] : all.find((e) => e.type === "email" || /user|login|email/i.test(e.name || e.id))) || null;
  }
  if (!element) return "none";
  const kind = (element.tagName === "INPUT" ? (element.getAttribute("type") || "text") : "other").toLowerCase();
  if (part === "secret" && kind !== "password") return "wrong-field";
  if (part === "username" && !["text", "email", "tel", "search"].includes(kind)) return "wrong-field";
  element.scrollIntoView({ block: "center" });
  element.focus();
  if ("value" in element) { element.value = ""; element.dispatchEvent(new Event("input", { bubbles: true })); }
  return document.activeElement === element ? "focused" : "unfocusable";
})()`;
}

export async function fillCredential(vault: Vault, args: { name?: string; fieldSelector?: string; part?: string }, endpoint = CDP_ENDPOINT): Promise<string> {
  const name = String(args.name ?? "");
  const part: Part = args.part === "username" ? "username" : "secret";
  const credential = vault.reveal(name);
  if (!credential) return `No saved login named "${name}". Ask the owner to add it in the panel.`;
  if (credential.kind === "api_key") return `Refused: "${name}" is an API key, not a site login. Use call_api instead; an API key is never typed into a page.`;
  if (!credential.site) return `Refused: "${name}" has no site, and a saved login is only filled on its own site. Ask the owner to set one.`;
  const value = part === "username" ? credential.username : credential.secret;
  const targets = await pageTargets(endpoint);
  let refusedSite = false;
  for (const target of targets) {
    if (!hostMatches(credential.site, target.url)) {
      refusedSite = true;
      continue;
    }
    const socket = await cdpConnect(target.webSocketDebuggerUrl!);
    try {
      const located = await cdpCall(socket, "Runtime.evaluate", { expression: locateFieldScript(String(args.fieldSelector ?? ""), part), returnByValue: true });
      const outcome = located?.result?.value;
      if (outcome === "bad-selector") return "That selector is not valid CSS. Use a CSS selector, label=<text>, or leave it empty.";
      if (outcome === "wrong-field") return part === "secret" ? "Refused: a password is only typed into a password field." : "Refused: a username is only typed into a text or email field.";
      if (outcome !== "focused") continue;
      const focused = await cdpCall(socket, "Runtime.evaluate", { expression: focusedKindScript(), returnByValue: true });
      if (!fieldAccepts(part, String(focused?.result?.value ?? ""))) return "Refused: the field changed before the value could be typed.";
      await cdpCall(socket, "Input.insertText", { text: value });
      return `Filled the ${part} of "${name}" into the field.`;
    } finally {
      socket.close();
    }
  }
  if (refusedSite) return `Refused: "${name}" is only for ${credential.site}, and no open page on that site has the field.`;
  return "Could not find that field on any open page.";
}

function reply(id: unknown, result: unknown) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function replyError(id: unknown, message: string) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message } })}\n`);
}

export function describeCredential(entry: CredentialInfo): string {
  if (entry.kind === "api_key") return `${entry.name}: API key for ${entry.site}${entry.tokenPath ? ", traded for an access token by the vault" : ""} (use call_api)`;
  return `${entry.name}: ${entry.username}${entry.site ? ` (${entry.site})` : ""}`;
}

function ownerApproval(home: string): Pick<ApiCallDeps, "approve" | "notify"> {
  const serverUrl = process.env.UNDERSTUDY_SERVER_URL || "";
  const token = process.env.AGENT_TOKEN || "";
  const notify = (event: Record<string, unknown>) => notifyGuardSocket(process.env.UNDERSTUDY_GUARD_SOCKET || `${home}/.understudy/guard.sock`, event);
  let gatekeeper: Promise<McpSession> | null = null;
  return {
    notify,
    async approve(request) {
      if (!serverUrl || !token) return { approved: false, text: "no gatekeeper configured" };
      gatekeeper ??= openGatekeeper(serverUrl, token).catch((error) => {
        gatekeeper = null;
        throw error;
      });
      const session = await gatekeeper;
      await notify({ event: "waiting", summary: request.summary });
      try {
        return await requestOwnerApproval(session, request);
      } finally {
        await notify({ event: "resumed" });
      }
    },
  };
}

async function serve() {
  const home = process.env.HOME || "/home/agent";
  const vault = openVault(home);
  const stateFile = process.env.UNDERSTUDY_TURN_FILE || turnStateFile(home);
  const apiDeps: ApiCallDeps = {
    filesDir: join(home, "files"),
    state: () => readTurnState(stateFile),
    rules: () => readRules(rulesFile(home)),
    ...ownerApproval(home),
  };
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message: { id?: unknown; method?: string; params?: any };
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id === undefined) continue;
    try {
      if (message.method === "initialize") {
        reply(message.id, { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "understudy-vault", version: "1" } });
      } else if (message.method === "tools/list") {
        reply(message.id, { tools: VAULT_TOOLS });
      } else if (message.method === "ping") {
        reply(message.id, {});
      } else if (message.method === "tools/call" && message.params?.name === "list_credentials") {
        const list = vault.list().map(describeCredential);
        reply(message.id, { content: [{ type: "text", text: list.length ? list.join("\n") : "No saved logins or API keys." }] });
      } else if (message.method === "tools/call" && message.params?.name === "fill_credential") {
        const text = await fillCredential(vault, message.params.arguments ?? {});
        reply(message.id, { content: [{ type: "text", text }] });
      } else if (message.method === "tools/call" && message.params?.name === "call_api") {
        const text = await callApi(vault, message.params.arguments ?? {}, apiDeps);
        reply(message.id, { content: [{ type: "text", text }] });
      } else {
        replyError(message.id, `unknown method ${message.method}`);
      }
    } catch (error) {
      reply(message.id, { content: [{ type: "text", text: `Failed: ${(error as Error).message}` }], isError: true });
    }
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  void serve();
}
