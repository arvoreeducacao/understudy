import assert from "node:assert/strict";
import { test } from "node:test";
import { credentialSendAs, credentialSite, credentialTokenPath } from "./credential-site";

test("a login is tied to the host of its site", () => {
  assert.equal(credentialSite("https://Bank.example.com/login?x=1"), "bank.example.com");
  assert.equal(credentialSite("bank.example.com"), "bank.example.com");
  assert.equal(credentialSite("bank.example.com:8443/path"), "bank.example.com");
});

test("a login without a usable site is refused", () => {
  for (const value of [undefined, null, "", "   ", "localhost", "*", "not a host", "http://", "bank..com", "-bad.example.com", 42]) {
    assert.equal(credentialSite(value), null, String(value));
  }
});

test("an API key says how it goes in the call", () => {
  assert.deepEqual(credentialSendAs("bearer", "ignored"), { sendAs: "bearer" });
  assert.deepEqual(credentialSendAs("basic", undefined), { sendAs: "basic" });
  assert.deepEqual(credentialSendAs("header", " X-Api-Key "), { sendAs: "header", field: "X-Api-Key" });
  assert.deepEqual(credentialSendAs("query", "api_key"), { sendAs: "query", field: "api_key" });
  assert.equal(credentialSendAs("header", "Cookie"), null);
  assert.equal(credentialSendAs("header", "bad header"), null);
  assert.equal(credentialSendAs("query", ""), null);
  assert.equal(credentialSendAs("cookie", "x"), null);
  assert.deepEqual(credentialSendAs("scheme", "ApiKey"), { sendAs: "scheme", field: "ApiKey" });
  assert.equal(credentialSendAs("scheme", "Api Key"), null);
  assert.equal(credentialTokenPath(""), undefined);
  assert.equal(credentialTokenPath(" /oauth/token "), "/oauth/token");
  assert.equal(credentialTokenPath("https://evil.example/token"), null);
});
