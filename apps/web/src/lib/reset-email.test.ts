import assert from "node:assert/strict";
import { test } from "node:test";
import { resetEmail } from "./reset-email";

test("the reset email links to the panel's own reset page", () => {
  process.env.UNDERSTUDY_PUBLIC_URL = "https://panel.example.com";
  const mail = resetEmail({ email: "ana@example.com", name: "Ana" }, "tok_123-abc");
  assert.equal(mail.to, "ana@example.com");
  assert.match(mail.text, /https:\/\/panel\.example\.com\/reset-password\?token=tok_123-abc/);
  assert.match(mail.text, /Ana/);
});
