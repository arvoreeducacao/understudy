import assert from "node:assert/strict";
import { test } from "node:test";
import { secretPassword, secretRegion } from "./password";

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
