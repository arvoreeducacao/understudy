import { z } from "zod";

export const APPROVAL_MODES = ["always", "on-miss", "auto", "off"] as const;
export const APPROVAL_FALLBACKS = ["wait", "deny"] as const;
export const APPROVAL_ALLOW_KINDS = ["host", "tool"] as const;
export const APPROVAL_ALLOW_LIMIT = 200;

export const ApprovalModeSchema = z.enum(APPROVAL_MODES);
export const ApprovalFallbackSchema = z.enum(APPROVAL_FALLBACKS);
export const ApprovalAllowSchema = z.object({ kind: z.enum(APPROVAL_ALLOW_KINDS), value: z.string().min(1).max(253) });
export const ComputerApprovalPolicySchema = z.object({
  mode: ApprovalModeSchema,
  hosts: z.array(z.string().min(1).max(253)).max(APPROVAL_ALLOW_LIMIT),
  ownerId: z.string().min(1).max(200).optional(),
});

export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;
export type ApprovalFallback = z.infer<typeof ApprovalFallbackSchema>;
export type ApprovalAllow = z.infer<typeof ApprovalAllowSchema>;
export type ApprovalPolicy = { mode: ApprovalMode; allow: ApprovalAllow[]; fallback: ApprovalFallback };
export type ComputerApprovalPolicy = z.infer<typeof ComputerApprovalPolicySchema>;
export type EffectiveApprovalMode = ApprovalMode;

export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = { mode: "on-miss", allow: [], fallback: "wait" };

const HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const TOOL_NAME = /^[a-z0-9][a-z0-9_.:-]{0,199}$/;

const SHARED_SECOND_LEVELS = new Set([
  "ac", "ad", "adv", "art", "biz", "blog", "co", "com", "ed", "edu", "eng", "gen", "go", "gob", "gouv", "gov", "govt", "gr", "gv", "id", "in", "ind", "inf", "info", "int", "jus", "leg",
  "lg", "ltd", "me", "med", "mil", "mp", "ne", "net", "nic", "nm", "nom", "or", "org", "plc", "pro", "rec", "res", "sch", "tm", "tur", "tv", "web", "wiki",
]);

export const SHARED_HOSTING_SUFFIXES: readonly string[] = [
  "amazonaws.com", "appspot.com", "azureedge.net", "blogspot.com.br", "bubbleapps.io", "carrd.co", "framer.website", "gitbook.io", "glide.page", "godaddysites.com", "hf.space",
  "notion.site", "readthedocs.io", "squarespace.com", "streamlit.app", "substack.com", "webflow.io", "weebly.com", "azurestaticapps.net", "azurewebsites.net", "b-cdn.net", "backblazeb2.com", "blogspot.com", "cloudflarestorage.com",
  "cloudfront.net", "cloudfunctions.net", "core.windows.net", "deno.dev", "digitaloceanspaces.com", "duckdns.org", "firebaseapp.com", "firebasestorage.app", "fly.dev", "github.io",
  "githubusercontent.com", "gitlab.io", "glitch.me", "googleapis.com", "googleusercontent.com", "herokuapp.com", "linodeobjects.com", "myshopify.com", "netlify.app", "ngrok-free.app",
  "ngrok.io", "no-ip.org", "now.sh", "onrender.com", "ondigitalocean.app", "pages.dev", "r2.dev", "railway.app", "repl.co", "replit.dev", "run.app", "sharepoint.com", "supabase.co",
  "surge.sh", "trycloudflare.com", "vercel.app", "wasabisys.com", "web.app", "wixsite.com", "wordpress.com", "workers.dev",
];

const SHARED_REGISTRY_SUFFIXES = new Set([
  "ae.org", "africa.com", "ar.com", "br.com", "cn.com", "co.com", "co.nl", "co.no", "com.de", "com.se", "de.com", "eu.com", "gb.com", "gb.net", "gr.com", "hu.com", "in.net", "it.com",
  "jp.net", "jpn.com", "kr.com", "mex.com", "no.com", "qc.com", "ru.com", "sa.com", "se.com", "se.net", "uk.com", "uk.net", "us.com", "us.org", "uy.com", "za.com", "za.net", "za.org",
]);

export function isSharedSuffix(host: string): boolean {
  const labels = host.split(".");
  if (labels.length < 2) return true;
  if (SHARED_HOSTING_SUFFIXES.some((apex) => host === apex || host.endsWith(`.${apex}`))) return true;
  if (SHARED_REGISTRY_SUFFIXES.has(host)) return true;
  if (labels.length === 2) return labels[1].length === 2 && SHARED_SECOND_LEVELS.has(labels[0]);
  return labels.length === 3 && labels[2].length === 2 && SHARED_SECOND_LEVELS.has(labels[1]) && labels[0].length === 2;
}

function hostnameOf(value: string): string {
  const trimmed = value.trim().toLowerCase();
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`).hostname.replace(/\.$/, "");
  } catch {
    return trimmed;
  }
}

export function allowedHost(value: string): string | null {
  const site = hostnameOf(value);
  if (!HOST_NAME.test(site) || IPV4.test(site) || isSharedSuffix(site)) return null;
  return site;
}

export function allowedTool(value: string): string | null {
  const name = value.normalize("NFKC").trim().toLowerCase().replace(/^mcp__gatekeeper__/, "");
  return TOOL_NAME.test(name) ? name : null;
}

export function cleanAllowEntry(input: unknown): ApprovalAllow | null {
  if (!input || typeof input !== "object") return null;
  const { kind, value } = input as { kind?: unknown; value?: unknown };
  if (typeof value !== "string") return null;
  if (kind === "host") {
    const host = allowedHost(value);
    return host ? { kind, value: host } : null;
  }
  if (kind === "tool") {
    const tool = allowedTool(value);
    return tool ? { kind, value: tool } : null;
  }
  return null;
}

function sameEntry(a: ApprovalAllow, b: ApprovalAllow) {
  return a.kind === b.kind && a.value === b.value;
}

export function cleanApprovalPolicy(input: unknown): ApprovalPolicy {
  const value = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const mode = APPROVAL_MODES.find((candidate) => candidate === value.mode) ?? DEFAULT_APPROVAL_POLICY.mode;
  const fallback = APPROVAL_FALLBACKS.find((candidate) => candidate === value.fallback) ?? DEFAULT_APPROVAL_POLICY.fallback;
  const allow: ApprovalAllow[] = [];
  for (const entry of Array.isArray(value.allow) ? value.allow : []) {
    const clean = cleanAllowEntry(entry);
    if (clean && !allow.some((kept) => sameEntry(kept, clean))) allow.push(clean);
    if (allow.length >= APPROVAL_ALLOW_LIMIT) break;
  }
  return { mode, allow, fallback };
}

export function withAllowed(policy: ApprovalPolicy, entry: ApprovalAllow): ApprovalPolicy {
  const clean = cleanAllowEntry(entry);
  if (!clean || policy.allow.some((kept) => sameEntry(kept, clean))) return policy;
  return { ...policy, allow: [...policy.allow, clean].slice(-APPROVAL_ALLOW_LIMIT) };
}

export function withoutAllowed(policy: ApprovalPolicy, entry: ApprovalAllow): ApprovalPolicy {
  return { ...policy, allow: policy.allow.filter((kept) => !sameEntry(kept, entry)) };
}

export function listedSite(host: string, hosts: readonly string[]): string | null {
  const site = allowedHost(host);
  if (!site) return null;
  return hosts.find((base) => allowedHost(base) === base && (site === base || site.endsWith(`.${base}`))) ?? null;
}

export function siteListed(host: string, hosts: readonly string[]): boolean {
  return listedSite(host, hosts) !== null;
}

export function toolListed(tool: string, allow: readonly ApprovalAllow[]): boolean {
  const name = allowedTool(tool);
  return Boolean(name) && allow.some((entry) => entry.kind === "tool" && entry.value === name);
}

export function listedHosts(policy: Pick<ApprovalPolicy, "allow">): string[] {
  return policy.allow.filter((entry) => entry.kind === "host").map((entry) => entry.value);
}

export function computerApprovalPolicy(policy: ApprovalPolicy, ownerId?: string): ComputerApprovalPolicy {
  return { mode: policy.mode, hosts: listedHosts(policy), ...(ownerId ? { ownerId } : {}) };
}

export function effectiveApprovalMode(mode: ApprovalMode, context: { untrusted?: boolean } = {}): EffectiveApprovalMode {
  if (mode === "always" || context.untrusted) return "always";
  return mode;
}

export function listCoversActions(mode: EffectiveApprovalMode): boolean {
  return mode === "on-miss" || mode === "auto";
}

const SENSITIVE_WORDS = new Set([
  "buy", "order", "orders", "pay", "delete", "destroy", "role", "roles", "grantaccess", "makeadmin", "signup", "signin", "login", "logon", "register", "createaccount", "newaccount",
  "closeaccount", "deleteaccount", "send", "share", "invite", "comment", "reply", "transaction", "transactions", "pix", "boleto", "withdraw", "donate", "auth", "oauth", "token",
  "otp", "2fa", "mfa", "password", "passwd", "senha", "finalizar", "criarconta", "entrar", "transferencia", "sacar", "saque", "doar", "permissao", "permissoes", "amount",
  "valor", "quantia", "topup", "revoke", "paid", "paying", "payer", "payout", "payouts", "sent", "bought", "ordered", "ordering", "sharing", "shared", "borrar", "lixeira", "doacao",
  "doacoes", "card", "cartao", "cvv", "cvc", "mandar", "erase", "discard", "refund", "redeem", "cashout", "wire", "checkout", "crearcuenta", "iniciarsesion", "quitar",
]);

const SENSITIVE_PREFIXES = [
  "verif", "authent", "authori", "otp", "permiss", "cadastr", "transfer", "purchas", "checkout", "payment", "pagament", "publish", "comment", "comenta", "delet", "invit",
  "convid", "compartilh", "envi", "pag", "exclu", "apag", "remov", "compr", "post", "publi", "encaminh", "forward", "confirm", "pedido", "assin", "subscri", "unsubscri", "revog",
  "revok", "admin", "membr", "member", "messag", "tweet", "charge", "trash", "suppr", "envoy", "losch", "kauf", "bezahl", "zahlung", "elimin", "deactiv", "desativ", "encerr",
  "resgat", "withdraw", "sell", "vend", "excluir", "send", "respond", "contrat", "aprov", "approv", "achet", "deposit", "retweet", "repost", "archiv", "suprim", "retir",
  "compart", "reenvi", "aprob", "descart",
];

const LOOSE_WORDS = new Set(["order", "orders", "token", "sent"]);

const NOT_SENSITIVE_PREFIXES = ["environ", "page", "pagin", "compress", "comprehen", "compromis", "postal", "postcode", "postgres", "sendgrid"];

const NOT_SENSITIVE_WORDS = new Set(["public", "publico", "publicos", "publicly"]);

const OPERATION_NAMES = /"operationName"\s*:\s*"([A-Za-z_]\w{0,99})"|operationName=([A-Za-z_]\w{0,99})|\bmutation\s+([A-Za-z_]\w{0,99})/g;

const GRAPHQL_MUTATION = /mutation/i;

const PERSISTED_QUERY = /persistedQuery|"doc_id"|(?:^|&)doc_id=/;

const BODY_VALUE = /^[^\s]{1,64}$/;

function words(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function sensitiveWord(word: string): boolean {
  if (SENSITIVE_WORDS.has(word)) return true;
  if (NOT_SENSITIVE_WORDS.has(word) || NOT_SENSITIVE_PREFIXES.some((prefix) => word.startsWith(prefix))) return false;
  return SENSITIVE_PREFIXES.some((prefix) => word.startsWith(prefix));
}

function sensitiveWords(tokens: string[], loose = false): boolean {
  const kept = loose ? tokens.filter((token) => !LOOSE_WORDS.has(token)) : tokens;
  return kept.some(sensitiveWord) || kept.slice(1).some((token, index) => SENSITIVE_WORDS.has(kept[index] + token));
}

export function confirmsAlways(text: string): boolean {
  return sensitiveWords(words(text));
}

function bodyParts(body: string): string[] {
  const parts: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (parts.length > 500 || depth > 8) return;
    if (typeof value === "string") {
      if (BODY_VALUE.test(value)) parts.push(value);
      return;
    }
    if (Array.isArray(value)) return value.forEach((item) => visit(item, depth + 1));
    if (value && typeof value === "object") {
      for (const item of Object.values(value)) visit(item, depth + 1);
    }
  };
  try {
    visit(JSON.parse(body), 0);
    return parts;
  } catch {}
  if (/^[^\s{}[\]]*=/.test(body)) {
    for (const value of new URLSearchParams(body).values()) if (BODY_VALUE.test(value)) parts.push(value);
  }
  return parts;
}

export function asksEveryTime(url: string, body?: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  let path = parsed.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {}
  if (sensitiveWords(words(path))) return true;
  if ([...parsed.searchParams.values()].some((value) => BODY_VALUE.test(value) && sensitiveWords(words(value), true))) return true;
  if (!body) return false;
  const head = body.slice(0, 20_000);
  if (GRAPHQL_MUTATION.test(head) || PERSISTED_QUERY.test(head)) return true;
  if ([...head.matchAll(OPERATION_NAMES)].some((match) => sensitiveWords(words(match[1] ?? match[2] ?? match[3] ?? "")))) return true;
  return bodyParts(head).some((part) => sensitiveWords(words(part), true));
}
