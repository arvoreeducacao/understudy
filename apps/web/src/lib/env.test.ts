import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { env, isAllowedEmail, isGoogleOnlyEmail } from "./env";

const saved = process.env.UNDERSTUDY_ALLOWED_EMAIL_DOMAIN;

afterEach(() => {
  process.env.UNDERSTUDY_ALLOWED_EMAIL_DOMAIN = saved;
});

test("accepts every domain in a comma separated list", () => {
  process.env.UNDERSTUDY_ALLOWED_EMAIL_DOMAIN = "example.com, @Example.org";
  assert.deepEqual(env.allowedEmailDomains, ["example.com", "example.org"]);
  assert.equal(isAllowedEmail("ana@example.com"), true);
  assert.equal(isAllowedEmail("Bia@EXAMPLE.org"), true);
  assert.equal(isAllowedEmail("eve@example.net"), false);
  assert.equal(isAllowedEmail("eve@notexample.com"), false);
});

test("a single domain keeps working as before", () => {
  process.env.UNDERSTUDY_ALLOWED_EMAIL_DOMAIN = "example.com";
  assert.deepEqual(env.allowedEmailDomains, ["example.com"]);
  assert.equal(isAllowedEmail("ana@example.com"), true);
  assert.equal(isAllowedEmail("ana@example.org"), false);
});

test("no domain leaves the list empty", () => {
  process.env.UNDERSTUDY_ALLOWED_EMAIL_DOMAIN = "";
  assert.deepEqual(env.allowedEmailDomains, []);
});

test("Google-only domains apply only when Google sign-in is configured", () => {
  const before = { id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET, only: process.env.UNDERSTUDY_GOOGLE_ONLY_DOMAINS };
  process.env.UNDERSTUDY_GOOGLE_ONLY_DOMAINS = "@Example.com";
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  assert.deepEqual(env.googleOnlyDomains, []);
  assert.equal(isGoogleOnlyEmail("ana@example.com"), false);
  process.env.GOOGLE_CLIENT_ID = "id";
  process.env.GOOGLE_CLIENT_SECRET = "secret";
  assert.deepEqual(env.googleOnlyDomains, ["example.com"]);
  assert.equal(isGoogleOnlyEmail("Ana@EXAMPLE.com"), true);
  assert.equal(isGoogleOnlyEmail("ana@partner.org"), false);
  for (const [key, value] of [["GOOGLE_CLIENT_ID", before.id], ["GOOGLE_CLIENT_SECRET", before.secret], ["UNDERSTUDY_GOOGLE_ONLY_DOMAINS", before.only]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
