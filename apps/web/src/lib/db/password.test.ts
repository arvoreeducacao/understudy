import assert from "node:assert/strict";
import { test } from "node:test";
import { rdsIamPassword, secretPassword, secretRegion } from "./password";

const credentials = async () => ({ accessKeyId: "AKIDEXAMPLE", secretAccessKey: "example-secret", sessionToken: "example-token" });
const arn = "arn:aws:secretsmanager:sa-east-1:123456789012:secret:rds!db-example";

function fakeSecretsManager(values: string[]) {
  const calls: Request[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const request = input as Request;
    calls.push(request);
    const value = values[Math.min(calls.length - 1, values.length - 1)];
    return new Response(JSON.stringify({ SecretString: value }), { status: 200 });
  }) as typeof fetch;
  return { calls, fetcher };
}

test("reads the password field of an RDS managed secret with a signed GetSecretValue call", async () => {
  const { calls, fetcher } = fakeSecretsManager([JSON.stringify({ username: "app", password: "first-password" })]);
  const password = secretPassword({ secretId: arn, region: "sa-east-1", credentials, fetcher });
  assert.equal(await password(), "first-password");
  const [request] = calls;
  assert.equal(request.url, "https://secretsmanager.sa-east-1.amazonaws.com/");
  assert.equal(request.headers.get("x-amz-target"), "secretsmanager.GetSecretValue");
  assert.match(request.headers.get("authorization") ?? "", /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/sa-east-1\/secretsmanager\/aws4_request/);
  assert.deepEqual(await request.json(), { SecretId: arn });
});

test("reuses the password for a minute, then picks up a rotated one", async () => {
  let clock = 0;
  const { calls, fetcher } = fakeSecretsManager([JSON.stringify({ password: "before-rotation" }), JSON.stringify({ password: "after-rotation" })]);
  const password = secretPassword({ secretId: arn, region: "sa-east-1", credentials, fetcher, now: () => clock });
  assert.equal(await password(), "before-rotation");
  clock = 59_000;
  assert.equal(await password(), "before-rotation");
  assert.equal(calls.length, 1);
  clock = 61_000;
  assert.equal(await password(), "after-rotation");
  assert.equal(calls.length, 2);
});

test("connections opening together share one lookup", async () => {
  const { calls, fetcher } = fakeSecretsManager([JSON.stringify({ password: "shared" })]);
  const password = secretPassword({ secretId: arn, region: "sa-east-1", credentials, fetcher });
  assert.deepEqual(await Promise.all([password(), password(), password()]), ["shared", "shared", "shared"]);
  assert.equal(calls.length, 1);
});

test("a plain string secret is the password itself", async () => {
  const { fetcher } = fakeSecretsManager(["plain-password"]);
  const password = secretPassword({ secretId: arn, region: "sa-east-1", credentials, fetcher });
  assert.equal(await password(), "plain-password");
});

test("a failed lookup is not cached", async () => {
  let fail = true;
  const fetcher = (async () => (fail ? new Response("denied", { status: 400 }) : new Response(JSON.stringify({ SecretString: JSON.stringify({ password: "recovered" }) })))) as typeof fetch;
  const password = secretPassword({ secretId: arn, region: "sa-east-1", credentials, fetcher });
  await assert.rejects(password(), /secretsmanager 400/);
  fail = false;
  assert.equal(await password(), "recovered");
});

test("the region comes from the secret ARN when there is one", () => {
  assert.equal(secretRegion(arn, "us-east-1"), "sa-east-1");
  assert.equal(secretRegion("my-db-secret", "us-east-1"), "us-east-1");
});

test("builds an RDS IAM auth token presigned for rds-db connect, valid for 15 minutes", async () => {
  const password = rdsIamPassword({ host: "db.example.us-east-1.rds.amazonaws.com", port: 5432, user: "app_user", region: "us-east-1", credentials });
  const token = await password();
  assert.ok(token.startsWith("db.example.us-east-1.rds.amazonaws.com:5432/?"));
  const params = new URL(`https://${token}`).searchParams;
  assert.equal(params.get("Action"), "connect");
  assert.equal(params.get("DBUser"), "app_user");
  assert.equal(params.get("X-Amz-Expires"), "900");
  assert.equal(params.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
  assert.match(params.get("X-Amz-Credential") ?? "", /^AKIDEXAMPLE\/\d{8}\/us-east-1\/rds-db\/aws4_request$/);
  assert.equal(params.get("X-Amz-Security-Token"), "example-token");
  assert.ok(params.get("X-Amz-Signature"));
});

test("reuses the RDS token for ten minutes, then signs a new one", async () => {
  let clock = 0;
  let calls = 0;
  const counted = async () => {
    calls += 1;
    return credentials();
  };
  const password = rdsIamPassword({ host: "db.example", port: 5432, user: "app_user", region: "us-east-1", credentials: counted, now: () => clock });
  await password();
  clock = 9 * 60 * 1000;
  await password();
  assert.equal(calls, 1);
  clock = 11 * 60 * 1000;
  await password();
  assert.equal(calls, 2);
});
