import assert from "node:assert/strict";
import { test } from "node:test";
import { canAlwaysAllow, ceilingFor, isReadOnly } from "@/lib/tool-policy";
import { answersGmailItself, GMAIL_ALWAYS_ASK, GMAIL_TOOLS, gmailApi, GmailError, mimeMessage, runGmailTool, type GmailApi, type GmailRequest } from "./gmail-direct";

type Call = { path: string; request: GmailRequest };

function fakeGmail(answers: Record<string, (request: GmailRequest) => unknown>) {
  const calls: Call[] = [];
  const api: GmailApi = async (path, request = {}) => {
    calls.push({ path, request });
    const answer = answers[path];
    if (!answer) throw new GmailError(404, `no fake for ${path}`);
    return answer(request);
  };
  return { api, calls };
}

function textOf(result: { content: { text: string }[] }) {
  return result.content[0].text;
}

function decodedRaw(raw: string) {
  return Buffer.from(raw, "base64url").toString("utf8");
}

test("only Google's Gmail server is answered by the panel itself", () => {
  assert.equal(answersGmailItself({ url: "https://gmailmcp.googleapis.com/mcp/v1" }), true);
  assert.equal(answersGmailItself({ url: "https://mcp.example.com/gmailmcp.googleapis.com" }), false);
  assert.equal(answersGmailItself({ url: "not a url" }), false);
});

test("reads are read-only, writes are not, and sending always asks", () => {
  const byName = new Map(GMAIL_TOOLS.map((tool) => [tool.name, tool]));
  for (const name of ["search_threads", "get_thread", "get_message", "list_drafts", "get_draft", "list_labels"]) assert.equal(isReadOnly(byName.get(name)?.annotations), true, name);
  assert.equal(isReadOnly(byName.get("create_draft")?.annotations), false);
  assert.equal(isReadOnly(byName.get("send_email")?.annotations), false);
  assert.equal(ceilingFor({ askTools: GMAIL_ALWAYS_ASK }, "send_email"), "ask");
  assert.equal(canAlwaysAllow({ askTools: GMAIL_ALWAYS_ASK }, "send_email"), false);
  assert.equal(canAlwaysAllow({ askTools: GMAIL_ALWAYS_ASK }, "create_draft"), true);
});

test("a message has its headers, encodes a non-ASCII subject and refuses line breaks", () => {
  const plain = mimeMessage({ to: ["ana@example.com"], cc: [], bcc: ["eu@example.com"], subject: "Relatório de treino", body: "Olá" });
  assert.match(plain, /^To: ana@example\.com\r\n/);
  assert.match(plain, /\r\nBcc: eu@example\.com\r\n/);
  assert.match(plain, /\r\nSubject: =\?UTF-8\?B\?UmVsYXTDs3JpbyBkZSB0cmVpbm8=\?=\r\n/);
  assert.match(plain, /Content-Type: text\/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\nT2zDoQ==/);
  const both = mimeMessage({ to: ["ana@example.com"], cc: [], bcc: [], subject: "Oi", body: "texto", htmlBody: "<p>texto</p>" }, "b1");
  assert.match(both, /Content-Type: multipart\/alternative; boundary="b1"/);
  assert.match(both, /--b1\r\nContent-Type: text\/plain[\s\S]*--b1\r\nContent-Type: text\/html[\s\S]*--b1--/);
  assert.throws(() => mimeMessage({ to: ["ana@example.com"], cc: [], bcc: [], subject: "Oi\r\nBcc: x@example.com", body: "" }), /line breaks/);
});

test("send_email checks its input before calling Gmail", async () => {
  const { api, calls } = fakeGmail({});
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ subject: "Oi", body: "x" }, /to needs at least one/],
    [{ to: ["Ana <ana@example.com>"], subject: "Oi", body: "x" }, /not a plain email address/],
    [{ to: ["ana@example.com"], body: "x" }, /subject is required/],
    [{ to: ["ana@example.com"], subject: "Oi" }, /body or htmlBody/],
    [{ to: ["ana@example.com"], subject: "Oi", body: "x", replyToMessageId: "../labels" }, /must be a Gmail id/],
  ];
  for (const [args, expected] of cases) {
    const result = await runGmailTool(api, "send_email", args);
    assert.equal(result.isError, true);
    assert.match(textOf(result), expected);
  }
  assert.equal(calls.length, 0);
});

test("send_email sends the raw message, and a reply stays in its thread", async () => {
  const { api, calls } = fakeGmail({
    "messages/m1": () => ({ id: "m1", threadId: "t1", payload: { headers: [{ name: "Message-ID", value: "<a@mail.example.com>" }, { name: "References", value: "<z@mail.example.com>" }] } }),
    "messages/send": () => ({ id: "m2", threadId: "t1", labelIds: ["SENT"] }),
  });
  const result = await runGmailTool(api, "send_email", { to: "ana@example.com, bia@example.com", subject: "Re: Treino", body: "Segue o relatório", replyToMessageId: "m1" });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(textOf(result)), { sent: true, id: "m2", threadId: "t1", labelIds: ["SENT"], viewUrl: "https://mail.google.com/mail/#all/t1" });
  const send = calls.find((call) => call.path === "messages/send");
  assert.equal(send?.request.method, "POST");
  const body = send?.request.body as { raw: string; threadId: string };
  assert.equal(body.threadId, "t1");
  const raw = decodedRaw(body.raw);
  assert.match(raw, /^To: ana@example\.com, bia@example\.com\r\n/);
  assert.match(raw, /\r\nIn-Reply-To: <a@mail\.example\.com>\r\n/);
  assert.match(raw, /\r\nReferences: <z@mail\.example\.com> <a@mail\.example\.com>\r\n/);
});

test("create_draft returns where to open the draft", async () => {
  const { api, calls } = fakeGmail({ drafts: () => ({ id: "r1", message: { id: "m9", threadId: "t9" } }) });
  const result = await runGmailTool(api, "create_draft", { to: ["ana@example.com"], subject: "Oi", body: "x" });
  assert.deepEqual(JSON.parse(textOf(result)), { id: "r1", messageId: "m9", threadId: "t9", viewUrl: "https://mail.google.com/mail/#drafts?compose=m9" });
  assert.ok((calls[0].request.body as { message: { raw: string } }).message.raw);
});

test("search_threads lists threads with their recent messages", async () => {
  const { api, calls } = fakeGmail({
    threads: () => ({ threads: [{ id: "t1", snippet: "Treino de hoje" }], nextPageToken: "p2" }),
    "threads/t1": () => ({ messages: [{ id: "m1", labelIds: ["INBOX"], payload: { headers: [{ name: "From", value: "Ana <ana@example.com>" }, { name: "Subject", value: "Treino" }] } }] }),
  });
  const result = JSON.parse(textOf(await runGmailTool(api, "search_threads", { query: "from:ana@example.com", pageSize: 5 })));
  assert.deepEqual(calls[0].request.query, { q: "from:ana@example.com", maxResults: 5, pageToken: undefined });
  assert.deepEqual(calls[1].request.query, { format: "metadata", metadataHeaders: ["From", "To", "Subject", "Date"] });
  assert.deepEqual(result, {
    threads: [{ id: "t1", viewUrl: "https://mail.google.com/mail/#all/t1", messageCount: 1, snippet: "Treino de hoje", messages: [{ id: "m1", labelIds: ["INBOX"], from: "Ana <ana@example.com>", subject: "Treino" }] }],
    nextPageToken: "p2",
  });
});

test("get_message reads the text body, falls back to the HTML one and lists attachments", async () => {
  const data = (text: string) => Buffer.from(text, "utf8").toString("base64url");
  const { api } = fakeGmail({
    "messages/m1": () => ({
      id: "m1",
      threadId: "t1",
      payload: {
        mimeType: "multipart/mixed",
        headers: [{ name: "Subject", value: "Planilha" }],
        parts: [
          { mimeType: "text/html", body: { data: data("<p>Olá&nbsp;Ana</p><script>x()</script>") } },
          { mimeType: "application/pdf", filename: "treino.pdf", body: { size: 1200, attachmentId: "a1" } },
        ],
      },
    }),
  });
  const result = JSON.parse(textOf(await runGmailTool(api, "get_message", { messageId: "m1" })));
  assert.equal(result.subject, "Planilha");
  assert.equal(result.body, "Olá Ana");
  assert.deepEqual(result.attachments, [{ filename: "treino.pdf", mimeType: "application/pdf", size: 1200 }]);
});

test("a Gmail error comes back as a tool error", async () => {
  const { api } = fakeGmail({ labels: () => Promise.reject(new GmailError(403, "Insufficient Permission")) });
  const result = await runGmailTool(api, "list_labels", {});
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Gmail answered 403: Insufficient Permission\. .*sign in again/);
  assert.match(textOf(await runGmailTool(api, "trash_thread", {})), /no action named trash_thread/);
});

test("the client renews an expired sign-in once and repeats the call", async () => {
  const seen: { url: string; auth: string | null }[] = [];
  let renewals = 0;
  const api = gmailApi({
    token: () => "old",
    renew: async () => `new${++renewals}`,
    base: "https://gmail.example/gmail/v1/users/me",
    fetch: async (url, init) => {
      const auth = new Headers(init.headers).get("authorization");
      seen.push({ url: url.toString(), auth });
      return auth === "Bearer new1" ? new Response(JSON.stringify({ labels: [] })) : new Response(JSON.stringify({ error: { message: "Invalid Credentials" } }), { status: 401 });
    },
  });
  assert.deepEqual(await api("threads", { query: { metadataHeaders: ["From", "To"], q: undefined } }), { labels: [] });
  assert.deepEqual(seen, [
    { url: "https://gmail.example/gmail/v1/users/me/threads?metadataHeaders=From&metadataHeaders=To", auth: "Bearer old" },
    { url: "https://gmail.example/gmail/v1/users/me/threads?metadataHeaders=From&metadataHeaders=To", auth: "Bearer new1" },
  ]);
  const stale = gmailApi({ token: () => "old", renew: async () => "still-bad", fetch: async () => new Response(JSON.stringify({ error: { message: "Invalid Credentials" } }), { status: 401 }) });
  await assert.rejects(stale("labels"), (error: unknown) => error instanceof GmailError && error.status === 401 && error.message === "Invalid Credentials");
});
