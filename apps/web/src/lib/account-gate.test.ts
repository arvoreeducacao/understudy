import assert from "node:assert/strict";
import { test } from "node:test";
import { accountBlock } from "./account-gate";

const ready = { status: "approved", mustChangePassword: false, twoFactorEnabled: true, googleOnly: false };

test("an approved account with two-step on gets in", () => {
  assert.equal(accountBlock(ready), null);
});

test("approval comes before anything else", () => {
  assert.equal(accountBlock({ ...ready, status: "pending", mustChangePassword: true, twoFactorEnabled: false }), "pending");
  assert.equal(accountBlock({ ...ready, status: "rejected" }), "pending");
});

test("a temporary password is replaced before two-step is set up", () => {
  assert.equal(accountBlock({ ...ready, mustChangePassword: true, twoFactorEnabled: false }), "change-password");
});

test("a password account without two-step must set it up", () => {
  assert.equal(accountBlock({ ...ready, twoFactorEnabled: false }), "two-factor");
});

test("a Google-only account relies on Google and skips both password steps", () => {
  assert.equal(accountBlock({ ...ready, twoFactorEnabled: false, googleOnly: true }), null);
  assert.equal(accountBlock({ ...ready, mustChangePassword: true, twoFactorEnabled: false, googleOnly: true }), null);
});
