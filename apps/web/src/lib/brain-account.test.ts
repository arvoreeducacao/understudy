import assert from "node:assert/strict";
import { test } from "node:test";
import { brainAccountView, cleanBrainAccount } from "./brain-account";

const seal = (plain: string) => `sealed:${plain}`;

test("a key of its own is saved sealed, with only its last characters kept in the clear", () => {
  const result = cleanBrainAccount({ own: true, url: "https://gateway.example.com/anthropic/", auth: "bearer", key: "sk-test-1234abcd", maxUsdPerTurn: "2,5" }, null, seal);
  assert.ok(result.ok);
  assert.deepEqual(result.ok && result.account, { url: "https://gateway.example.com/anthropic", auth: "bearer", key: "sealed:sk-test-1234abcd", last4: "abcd", maxUsdPerTurn: 2.5 });
  assert.deepEqual(brainAccountView(result.ok ? result.account : null), { url: "https://gateway.example.com/anthropic", auth: "bearer", last4: "abcd", maxUsdPerTurn: 2.5 });
});

test("the saved key is kept when only the limit changes, but a new address needs the key again", () => {
  const previous = { url: null, auth: "x-api-key" as const, key: "sealed:old", last4: "9xyz", maxUsdPerTurn: null };
  const kept = cleanBrainAccount({ own: true, maxUsdPerTurn: 4 }, previous, seal);
  assert.ok(kept.ok && kept.account?.key === "sealed:old" && kept.account.maxUsdPerTurn === 4);
  assert.deepEqual(cleanBrainAccount({ own: true, url: "https://elsewhere.example.com" }, previous, seal), { ok: false, problem: "key" });
});

test("bad addresses, keys and limits are refused, and turning it off clears everything", () => {
  assert.deepEqual(cleanBrainAccount({ own: true, url: "http://gateway.example.com", key: "sk-test-1234abcd" }, null, seal), { ok: false, problem: "url" });
  assert.deepEqual(cleanBrainAccount({ own: true, url: "https://user:pw@gateway.example.com", key: "sk-test-1234abcd" }, null, seal), { ok: false, problem: "url" });
  assert.deepEqual(cleanBrainAccount({ own: true, key: "short" }, null, seal), { ok: false, problem: "key" });
  assert.deepEqual(cleanBrainAccount({ own: true }, null, seal), { ok: false, problem: "key" });
  assert.deepEqual(cleanBrainAccount({ own: true, key: "sk-test-1234abcd", maxUsdPerTurn: "0" }, null, seal), { ok: false, problem: "budget" });
  assert.deepEqual(cleanBrainAccount({ own: true, key: "sk-test-1234abcd", maxUsdPerTurn: 5000 }, null, seal), { ok: false, problem: "budget" });
  assert.ok(cleanBrainAccount({ own: true, url: "http://localhost:4000", key: "sk-test-1234abcd" }, null, seal, true).ok);
  assert.deepEqual(cleanBrainAccount({ own: false, key: "sk-test-1234abcd" }, null, seal), { ok: true, account: null });
});
