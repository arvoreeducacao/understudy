import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, test } from "node:test";
import { eq, like } from "drizzle-orm";

const url = process.env.TEST_DATABASE_URL;
const skip = !url && "set TEST_DATABASE_URL to a disposable Postgres to run";
if (url) process.env.DATABASE_URL = url;
process.env.BETTER_AUTH_SECRET ??= "test-secret-test-secret-test-secret";
process.env.UNDERSTUDY_PUBLIC_URL = "http://localhost:3998";
process.env.UNDERSTUDY_ALLOWED_EMAIL_DOMAIN = "tf.test,staff.tf.test";
process.env.UNDERSTUDY_GOOGLE_ONLY_DOMAINS = "staff.tf.test";
process.env.GOOGLE_CLIENT_ID = "test-client";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
process.env.UNDERSTUDY_SMTP_URL = "json";

const ORIGIN = "http://localhost:3998";
const PASSWORD = "a-long-password";

function totp(uri: string, at = Date.now()) {
  const secret = new URL(uri).searchParams.get("secret") ?? "";
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret.replace(/=+$/, "")) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)?.map((byte) => parseInt(byte, 2)) ?? []);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const hmac = createHmac("sha1", key).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

async function post(path: string, body: unknown, cookie = "") {
  const { getAuth } = await import("@/lib/auth");
  const res = await getAuth().handler(
    new Request(`${ORIGIN}/api/auth${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
      body: JSON.stringify(body),
    }),
  );
  const cookies = res.headers.getSetCookie().filter((c) => !/max-age=0/i.test(c)).map((c) => c.split(";")[0]).join("; ");
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null, cookies };
}

async function cleanup() {
  const { getDb, schema } = await import("@/lib/db");
  await getDb().delete(schema.user).where(like(schema.user.email, "%tf.test"));
}

let userId = "";

before(async () => {
  if (!url) return;
  await (await import("./test-db")).migrateTestDb();
  await cleanup();
  const { createUserWithPassword } = await import("@/lib/users");
  userId = (await createUserWithPassword({ email: "ana@tf.test", name: "Ana", password: PASSWORD, mustChangePassword: false })).id;
});

after(async () => {
  if (!url) return;
  await cleanup();
  const { getPool } = await import("@/lib/db");
  await getPool().end();
  setTimeout(() => process.exit(0), 100).unref();
});

test("a password account is sent to set up two-step, and after it every sign-in asks for the code", { skip }, async () => {
  const { userBlock } = await import("@/lib/account-gate");
  const { getDb, schema } = await import("@/lib/db");
  const first = await post("/sign-in/email", { email: "ana@tf.test", password: PASSWORD });
  assert.equal(first.status, 200);
  const [fresh] = await getDb().select().from(schema.user).where(eq(schema.user.id, userId));
  assert.equal(userBlock(fresh), "two-factor");

  const enabled = await post("/two-factor/enable", { password: PASSWORD }, first.cookies);
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  const uri = String(enabled.body?.totpURI);
  assert.equal((await post("/two-factor/verify-totp", { code: "000000" }, first.cookies)).status, 401);
  const verified = await post("/two-factor/verify-totp", { code: totp(uri) }, first.cookies);
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  const [enrolled] = await getDb().select().from(schema.user).where(eq(schema.user.id, userId));
  assert.equal(userBlock(enrolled), null);

  const again = await post("/sign-in/email", { email: "ana@tf.test", password: PASSWORD });
  assert.equal(again.body?.twoFactorRedirect, true);
  assert.doesNotMatch(again.cookies, /session_token=/, "no session until the code is right");
  const challenged = await post("/two-factor/verify-totp", { code: totp(uri) }, again.cookies);
  assert.equal(challenged.status, 200, JSON.stringify(challenged.body));
});

test("an admin reset link works once, signs the person out and keeps two-step", { skip }, async () => {
  const { issueResetLink, resetLinkOwner } = await import("@/lib/reset-link");
  const { getAuth } = await import("@/lib/auth");
  const { getDb, schema } = await import("@/lib/db");
  const older = new URL(await issueResetLink(userId)).searchParams.get("token") ?? "";
  const link = new URL(await issueResetLink(userId));
  const token = link.searchParams.get("token") ?? "";
  assert.equal(link.origin + link.pathname, `${ORIGIN}/reset-password`);
  assert.equal(await resetLinkOwner(older), null, "a new link replaces the previous one");
  assert.equal(await resetLinkOwner(token), userId);
  assert.equal(await resetLinkOwner(token, new Date(Date.now() + 25 * 60 * 60 * 1000)), null, "expires after a day");

  await getAuth().api.resetPassword({ body: { token, newPassword: "another-long-one" } });
  assert.equal(await resetLinkOwner(token), null);
  assert.equal((await getDb().select().from(schema.session).where(eq(schema.session.userId, userId))).length, 0);
  assert.equal((await post("/sign-in/email", { email: "ana@tf.test", password: PASSWORD })).status, 401);
  assert.equal((await post("/sign-in/email", { email: "ana@tf.test", password: "another-long-one" })).body?.twoFactorRedirect, true);
});

test("a Google-only address cannot sign up, sign in with a password or be created with one", { skip }, async () => {
  const { createUserWithPassword } = await import("@/lib/users");
  const { getDb, schema } = await import("@/lib/db");
  assert.equal((await post("/sign-up/email", { email: "bia@staff.tf.test", password: PASSWORD, name: "Bia" })).status, 403);
  await assert.rejects(createUserWithPassword({ email: "bia@staff.tf.test", name: "Bia", password: PASSWORD }), /google_only/);
  const now = new Date();
  await getDb().insert(schema.user).values({ id: "usr_tf_bia", name: "Bia", email: "bia@staff.tf.test", status: "approved", createdAt: now, updatedAt: now });
  const ctx = await (await import("@/lib/auth")).getAuth().$context;
  await ctx.internalAdapter.linkAccount({ providerId: "credential", accountId: "usr_tf_bia", userId: "usr_tf_bia", password: await ctx.password.hash(PASSWORD) });
  assert.equal((await post("/sign-in/email", { email: "bia@staff.tf.test", password: PASSWORD })).status, 403);
});

test("a forgotten password sends a one-hour link, except to a Google-only address", { skip }, async () => {
  const { getDb, schema } = await import("@/lib/db");
  const resets = async () =>
    (await getDb().select().from(schema.verification).where(eq(schema.verification.value, userId))).filter((row) => row.identifier.startsWith("reset-password:"));
  const before = (await resets()).length;
  const asked = await post("/request-password-reset", { email: "ana@tf.test" });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  const rows = await resets();
  assert.equal(rows.length, before + 1);
  const ttl = rows[rows.length - 1].expiresAt.getTime() - Date.now();
  assert.ok(ttl > 55 * 60 * 1000 && ttl <= 60 * 60 * 1000);
  assert.equal((await post("/request-password-reset", { email: "nobody@tf.test" })).status, 200, "an unknown address looks the same");
  assert.equal((await post("/request-password-reset", { email: "bia@staff.tf.test" })).status, 403);
});
