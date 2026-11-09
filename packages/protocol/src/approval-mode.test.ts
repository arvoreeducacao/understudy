import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allowedHost,
  asksEveryTime,
  confirmsAlways,
  allowedTool,
  cleanApprovalPolicy,
  computerApprovalPolicy,
  DEFAULT_APPROVAL_POLICY,
  effectiveApprovalMode,
  listCoversActions,
  parseServerToComputer,
  siteListed,
  toolListed,
  withAllowed,
  withoutAllowed,
} from "./index.ts";

test("a missing or broken policy is today's behavior: ask what is not allowed, nothing allowed, wait", () => {
  assert.deepEqual(cleanApprovalPolicy(undefined), DEFAULT_APPROVAL_POLICY);
  assert.deepEqual(cleanApprovalPolicy({ mode: "yolo", fallback: "later", allow: "everything" }), { mode: "on-miss", allow: [], fallback: "wait" });
  assert.deepEqual(DEFAULT_APPROVAL_POLICY, { mode: "on-miss", allow: [], fallback: "wait" });
  assert.equal(cleanApprovalPolicy({ mode: "on-miss", allow: [], fallback: "allow" }).fallback, "wait");
});

test("allowed sites are stored as the exact host name and tools as gatekeeper names", () => {
  assert.equal(allowedHost("https://www.Example.com/path?q=1"), "www.example.com");
  assert.equal(allowedHost("example.com."), "example.com");
  assert.equal(allowedHost("shop.example.co.uk"), "shop.example.co.uk");
  assert.equal(allowedHost("not a host"), null);
  assert.equal(allowedHost(""), null);
  assert.equal(allowedTool("mcp__gatekeeper__Slack_Post_Message"), "slack_post_message");
  assert.equal(allowedTool("rm -rf /"), null);
  const policy = cleanApprovalPolicy({
    mode: "off",
    fallback: "deny",
    allow: [
      { kind: "host", value: "https://Example.com/" },
      { kind: "host", value: "example.com" },
      { kind: "tool", value: "slack_post_message" },
      { kind: "file", value: "/etc/passwd" },
      { kind: "host", value: "<script>" },
    ],
  });
  assert.deepEqual(policy, { mode: "off", fallback: "deny", allow: [{ kind: "host", value: "example.com" }, { kind: "tool", value: "slack_post_message" }] });
});

test("a listed site covers its subdomains, never a look-alike", () => {
  const hosts = ["example.com"];
  assert.equal(siteListed("example.com", hosts), true);
  assert.equal(siteListed("www.example.com", hosts), true);
  assert.equal(siteListed("api.example.com", hosts), true);
  assert.equal(siteListed("notexample.com", hosts), false);
  assert.equal(siteListed("example.com.evil.test", hosts), false);
  assert.equal(siteListed("", hosts), false);
});

test("adding and removing entries keeps the list clean and bounded", () => {
  let policy = withAllowed(DEFAULT_APPROVAL_POLICY, { kind: "host", value: "https://SHOP.test/cart" });
  policy = withAllowed(policy, { kind: "host", value: "shop.test" });
  policy = withAllowed(policy, { kind: "tool", value: "slack_send_dm" });
  assert.deepEqual(policy.allow, [{ kind: "host", value: "shop.test" }, { kind: "tool", value: "slack_send_dm" }]);
  assert.equal(toolListed("mcp__gatekeeper__slack_send_dm", policy.allow), true);
  assert.equal(toolListed("slack_post_message", policy.allow), false);
  assert.deepEqual(withoutAllowed(policy, { kind: "host", value: "shop.test" }).allow, [{ kind: "tool", value: "slack_send_dm" }]);
  let full = DEFAULT_APPROVAL_POLICY;
  for (let index = 0; index < 205; index++) full = withAllowed(full, { kind: "host", value: `site${index}.test` });
  assert.equal(full.allow.length, 200);
  assert.equal(full.allow[0].value, "site5.test");
});

test("sending, transfers, payments, sign-ins and deletes are asked every time, by stem, in a button, an address, a query or a request body", () => {
  for (const text of ["Send", "Enviar", "Envie", "Publicar", "Post", "Postagem", "Transferir", "Confirmar", "Confirmar transferência", "Enviar Pix", "Pay now", "Pague", "Place order", "Fazer pedido", "Compre", "Delete repository", "Exclua", "Apague", "Eliminar", "Encaminhar", "Sign in", "Criar conta", "Close account", "Share", "Reply", "Revoke", "Unsubscribe", "Tornar administrador", "Adicionar membro", "Supprimer", "Envoyer", "Löschen", "Kaufen", "Bezahlen"])
    assert.equal(confirmsAlways(`click ${text}`), true, text);
  for (const text of ["Like", "Next", "Next page", "Search", "Save draft", "Show public profile", "Compress image", "Postal code", "Environment", "Cancel", "Filter"]) assert.equal(confirmsAlways(`click ${text}`), false, text);
  for (const url of [
    "https://x.com/i/api/graphql/abc/CreateTweet",
    "https://app.slack.com/api/chat.postMessage",
    "https://www.notion.so/api/v3/submitTransaction",
    "https://mail.google.com/sync/u/0/i/s?action=send",
    "https://bank.example/api/pix",
    "https://bank.example/pix/transferir/confirmacao",
    "https://chat.test/channels/x/messages",
    "https://api.x.test/2/tweets",
    "https://api.pay.test/v1/charges",
    "https://www.social.test/api/posts",
    "https://drive.test/files/x/trash",
    "https://app.test/api/v2/session/verify-code",
  ])
    assert.equal(asksEveryTime(url), true, url);
  for (const url of ["https://www.social.test/api/like", "https://app.test/api/catalog/search", "https://app.test/api/page/2", "https://app.test/api/%E0%A4%A"]) assert.equal(asksEveryTime(url), false, url);
  assert.equal(asksEveryTime("not a url"), true);
  assert.equal(asksEveryTime("https://app.test/api/do", "action=delete&id=3"), true);
  assert.equal(asksEveryTime("https://app.test/api/do", JSON.stringify({ op: "send_message", id: 3 })), true);
  assert.equal(asksEveryTime("https://api.github.com/graphql", JSON.stringify({ query: "mutation { addStar(input: {}) { clientMutationId } }" })), true);
  assert.equal(asksEveryTime("https://api.github.com/graphql", JSON.stringify({ operationName: "SubmitTransaction", variables: {} })), true);
  assert.equal(asksEveryTime("https://api.github.com/graphql", JSON.stringify({ query: "query { viewer { login } }" })), false);
  assert.equal(asksEveryTime("https://app.test/api/save", JSON.stringify({ text: "please pay me later", draft: true })), false);
  assert.equal(asksEveryTime("https://x.test/graphql", JSON.stringify({ extensions: { persistedQuery: { sha256Hash: "abc" } }, variables: {} })), true);
  assert.equal(asksEveryTime("https://social.test/api/graphql/", "doc_id=123&variables=%7B%7D"), true);
  assert.equal(asksEveryTime("https://social.test/api/graphql/", "fb_api_req_friendly_name=useAddReactionMutation&variables=%7B%7D"), true);
  assert.equal(asksEveryTime("https://x.test/gql", JSON.stringify({ query: "MUTATION Save { save }" })), true);
  assert.equal(asksEveryTime("https://x.test/api/list?order=desc&sort_order=asc&token=abc", JSON.stringify({ order: "desc", token: "abc", authenticity_token: "z", _token: "y", status: "sent" })), false);
  for (const text of ["Card number", "Cartão", "CVV", "Quitar", "Borrar", "Suprimir", "Retirar", "Compartir", "Reenviar", "Aprobar", "Crear cuenta", "Iniciar sesión", "Mandar", "Descartar", "Check out", "Erase", "Discard", "Refund", "Redeem", "Cash out", "Wire"])
    assert.equal(confirmsAlways(`click ${text}`), true, text);
});

test("turns that are not the owner's ask as before, ignoring the list", () => {
  assert.equal(effectiveApprovalMode("off"), "off");
  assert.equal(effectiveApprovalMode("off", { untrusted: true }), "always");
  assert.equal(effectiveApprovalMode("on-miss", { untrusted: true }), "always");
  assert.equal(effectiveApprovalMode("always", { untrusted: true }), "always");
  assert.equal(effectiveApprovalMode("auto"), "on-miss");
  assert.equal(listCoversActions("on-miss"), true);
  assert.equal(listCoversActions("always"), false);
});

test("the computer gets the mode, the listed sites and who the owner is", () => {
  const policy = cleanApprovalPolicy({ mode: "always", allow: [{ kind: "host", value: "shop.test" }, { kind: "tool", value: "slack_send_dm" }] });
  const wire = computerApprovalPolicy(policy, "user_1");
  assert.deepEqual(wire, { mode: "always", hosts: ["shop.test"], ownerId: "user_1" });
  assert.equal(parseServerToComputer({ type: "set_approval_policy", policy: wire }).ok, true);
  assert.equal(parseServerToComputer({ type: "set_approval_policy", policy: { mode: "sometimes", hosts: [] } }).ok, false);
});

test("a public suffix, a shared hosting domain, a bare name or an address is never a site to allow", () => {
  for (const value of ["com", "gov.br", "co.uk", "com.br", "github.io", "vercel.app", "localhost", "1", "192.168.0.1", "sp.gov.br", "br.com", "us.com"]) assert.equal(allowedHost(value), null, value);
  for (const value of ["s3.amazonaws.com", "s3.us-east-1.amazonaws.com", "my-bucket.s3.amazonaws.com", "storage.googleapis.com", "attacker.github.io", "app.vercel.app", "x.blob.core.windows.net"]) assert.equal(allowedHost(value), null, value);
  assert.equal(allowedHost("https://www.gov.br/receitafederal"), "www.gov.br");
  assert.equal(allowedHost("www.sp.gov.br"), "www.sp.gov.br");
  assert.equal(allowedHost("loja.br.com"), "loja.br.com");
  assert.equal(allowedHost("hp.com"), "hp.com");
  assert.equal(allowedHost("example.com:8443"), "example.com");
  assert.equal(siteListed("any-shop.com", ["com"]), false);
  assert.equal(siteListed("attacker.github.io", ["github.io"]), false);
  assert.equal(siteListed("attacker-bucket.s3.amazonaws.com", ["s3.amazonaws.com"]), false);
  assert.equal(siteListed("mail.google.com", [allowedHost("https://www.google.com/search?q=x")!]), false);
  assert.deepEqual(cleanApprovalPolicy({ allow: [{ kind: "host", value: "com" }, { kind: "host", value: "github.io" }] }).allow, []);
});
