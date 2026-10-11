import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEmail } from "../../inbound-email/parse";
import { replySubject, stripQuoted } from "./address";
import { classifySender } from "./inbound";
import { composeEmail, outboundConfig } from "./outbound";

test("quoted history and reply headers are cut from what the understudy reads", () => {
  assert.equal(stripQuoted("Yes, go ahead.\n\nOn Mon, Oct 5, 2026 at 9:00 AM Ada <ada@mail.example.com> wrote:\n> Shall I pay?\n> Thanks"), "Yes, go ahead.");
  assert.equal(stripQuoted("Sim.\n\nEm seg., 5 de out. de 2026 às 09:00, Ada escreveu:\n> Posso pagar?"), "Sim.");
  assert.equal(stripQuoted("Done\n\nFrom: Ada <ada@mail.example.com>\nSent: Monday\nTo: Maya\n\nold"), "Done");
  assert.equal(stripQuoted("From: the board, three notes\n1. budget"), "From: the board, three notes\n1. budget");
  assert.equal(stripQuoted("> only a quote"), "> only a quote");
});

test("replies keep one Re: prefix", () => {
  assert.equal(replySubject("Invoice 42"), "Re: Invoice 42");
  assert.equal(replySubject("RE: Invoice 42"), "RE: Invoice 42");
  assert.equal(replySubject("  "), "");
});

test("the owner is recognised by exact address and others only by the allowed list", () => {
  assert.equal(classifySender("Maya@Example.com", null, "maya@example.com"), "owner");
  assert.equal(classifySender("teammate@example.com", null, "maya@example.com"), "unknown");
  assert.equal(classifySender("buyer@example.org", "example.org", "maya@example.com"), "allowed");
  assert.equal(classifySender("buyer@sub.example.org", "example.org", "maya@example.com"), "unknown");
  assert.equal(classifySender("one@example.net", "one@example.net, two@example.net", "maya@example.com"), "allowed");
  assert.equal(classifySender(null, "example.org", "maya@example.com"), "unknown");
});

test("outbound mail is off unless SES or an SMTP URL is configured", () => {
  assert.deepEqual(outboundConfig({}), { mode: "off" });
  assert.deepEqual(outboundConfig({ UNDERSTUDY_OUTBOUND_EMAIL: "ses", AWS_REGION: "eu-west-1" }), { mode: "ses", region: "eu-west-1" });
  assert.deepEqual(outboundConfig({ UNDERSTUDY_OUTBOUND_EMAIL: "smtps://user:pass@smtp.example.com:465" }), { mode: "smtp", url: "smtps://user:pass@smtp.example.com:465" });
  assert.deepEqual(outboundConfig({ UNDERSTUDY_OUTBOUND_EMAIL: "http://example.com" }), { mode: "off" });
});

test("a composed reply threads under the original and cannot smuggle headers through the name or subject", async () => {
  const raw = await composeEmail({
    from: { name: 'Ada"\r\nBcc: victim@example.net', address: "ada.abcdefghij@mail.example.com" },
    to: "maya@example.com",
    subject: "Re: Hi\r\nBcc: victim@example.net",
    text: "Hello",
    messageId: "<r1@mail.example.com>",
    inReplyTo: "<m1@example.com>",
    references: ["<m0@example.com>", "<m1@example.com>"],
    attachments: [{ filename: "a.txt", contentType: "text/plain", content: Buffer.from("hi") }],
  });
  const text = raw.toString();
  assert.doesNotMatch(text, /^Bcc:/im);
  const parsed = await parseEmail(raw, 1000);
  assert.equal(parsed.messageId, "<r1@mail.example.com>");
  assert.equal(parsed.inReplyTo, "<m1@example.com>");
  assert.deepEqual(parsed.references, ["<m0@example.com>", "<m1@example.com>"]);
  assert.equal(parsed.automated, true);
  assert.equal(parsed.attachments[0].filename, "a.txt");
});
