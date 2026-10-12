import assert from "node:assert/strict";
import { test } from "node:test";
import { identityOf, isSelfChat, jidOf, paceMs, parseApprovalReply, peerOf, phoneOf, readMessage } from "./message";

test("numbers come only from phone-number addresses", () => {
  assert.equal(phoneOf("15550100000@s.whatsapp.net"), "+15550100000");
  assert.equal(phoneOf("15550100000:12@s.whatsapp.net"), "+15550100000");
  assert.equal(phoneOf("98765@lid"), null);
  assert.equal(jidOf("+15550100000"), "15550100000@s.whatsapp.net");
  assert.deepEqual(identityOf({ id: "15550100000:7@s.whatsapp.net", lid: "98765:7@lid" }), { jid: "15550100000@s.whatsapp.net", lid: "98765@lid", number: "+15550100000" });
});

test("the owner's own chat is recognised by number or by its private id", () => {
  const me = { jid: "15550100000@s.whatsapp.net", lid: "98765@lid", number: "+15550100000" };
  assert.equal(isSelfChat({ chat: "98765@lid", chatAlt: null }, me), true);
  assert.equal(isSelfChat({ chat: "15550100000@s.whatsapp.net", chatAlt: null }, me), true);
  assert.equal(isSelfChat({ chat: "11111@lid", chatAlt: "15550100099@s.whatsapp.net" }, me), false);
  assert.equal(peerOf({ chat: "11111@lid", chatAlt: "15550100099@s.whatsapp.net" }), "+15550100099");
});

test("groups, broadcasts and empty messages are skipped, and captions count as text", () => {
  const at = Math.floor(Date.now() / 1000);
  assert.equal(readMessage({ key: { remoteJid: "120363000000000000@g.us", id: "G" }, message: { conversation: "hi" }, messageTimestamp: at } as never), null);
  assert.equal(readMessage({ key: { remoteJid: "status@broadcast", id: "S" }, message: { conversation: "hi" }, messageTimestamp: at } as never), null);
  assert.equal(readMessage({ key: { remoteJid: "15550100099@s.whatsapp.net", id: "E" }, message: { protocolMessage: {} }, messageTimestamp: at } as never), null);
  const photo = readMessage({ key: { remoteJid: "15550100099@s.whatsapp.net", id: "P1" }, message: { imageMessage: { caption: "receipt", mimetype: "image/jpeg", fileLength: 2048 } }, messageTimestamp: at } as never);
  assert.deepEqual([photo?.text, photo?.media?.kind, photo?.media?.bytes], ["receipt", "image", 2048]);
  const wrapped = readMessage({ key: { remoteJid: "15550100099@s.whatsapp.net", id: "W" }, message: { ephemeralMessage: { message: { extendedTextMessage: { text: "disappearing" } } } }, messageTimestamp: at } as never);
  assert.equal(wrapped?.text, "disappearing");
});

test("approval replies accept a number or a word, with an optional code", () => {
  assert.deepEqual(parseApprovalReply("1"), { approved: true, code: null });
  assert.deepEqual(parseApprovalReply(" 2 k7m "), { approved: false, code: "K7M" });
  assert.deepEqual(parseApprovalReply("sim"), { approved: true, code: null });
  assert.deepEqual(parseApprovalReply("Não."), { approved: false, code: null });
  assert.equal(parseApprovalReply("1 more thing to do"), null);
  assert.equal(parseApprovalReply("12"), null);
  assert.equal(parseApprovalReply("1 TOOLONG"), null);
});

test("sending waits about as long as a person would take to type, within limits", () => {
  assert.equal(paceMs("ok", () => 0.5), 950);
  assert.equal(paceMs("x".repeat(1000), () => 0.5), 6000);
  assert.ok(paceMs("hello there", () => 0) < paceMs("hello there", () => 1));
});

test("a download stops as soon as it passes the limit", async () => {
  const { Readable } = await import("node:stream");
  const { readCapped } = await import("./sessions");
  let destroyed = false;
  const big = Readable.from([Buffer.alloc(600), Buffer.alloc(600), Buffer.alloc(600)]);
  const destroy = big.destroy.bind(big);
  big.destroy = (error?: Error) => {
    destroyed = true;
    return destroy(error);
  };
  assert.equal(await readCapped(big, 1000), null);
  assert.equal(destroyed, true);
  assert.equal((await readCapped(Readable.from([Buffer.alloc(300), Buffer.alloc(300)]), 1000))?.length, 600);
});
