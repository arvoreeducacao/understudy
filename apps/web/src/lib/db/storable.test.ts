import assert from "node:assert/strict";
import { test } from "node:test";
import { storableJson, storableText } from "./storable";

test("storableText replaces the characters Postgres refuses and keeps everything else", () => {
  assert.equal(storableText("a\u0000b"), "a\uFFFDb");
  assert.equal(storableText("cut \uD83D"), "cut \uFFFD");
  assert.equal(storableText("\uDE00 tail"), "\uFFFD tail");
  assert.equal(storableText("emoji \uD83D\uDE00 ok"), "emoji \uD83D\uDE00 ok");
  assert.equal(storableText("plain text\nwith lines\tand tabs"), "plain text\nwith lines\tand tabs");
});

test("storableJson cleans every string inside arrays and objects", () => {
  const gzipHead = "\u001f\uFFFD\b\u0000\u0000\u0000\u0000\u0000\u0000\u0003";
  const fields = [
    { label: "Request", value: "POST https://telemetry.example.com/log" },
    { label: "Body", value: gzipHead },
  ];
  const cleaned = storableJson(fields);
  assert.equal(cleaned[0].value, "POST https://telemetry.example.com/log");
  assert.equal(cleaned[1].value.includes("\u0000"), false);
  assert.deepEqual(storableJson({ "k\u0000": ["x\u0000", 1, null, true] }), { "k\uFFFD": ["x\uFFFD", 1, null, true] });
});

test("storableJson leaves non-string values alone", () => {
  const when = new Date(0);
  assert.equal(storableJson(when), when);
  assert.equal(storableJson(42), 42);
  assert.equal(storableJson(null), null);
  assert.equal(storableJson(undefined), undefined);
});
