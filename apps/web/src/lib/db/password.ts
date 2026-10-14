import { AwsClient } from "aws4fetch";
import { type AwsCredentials, awsCredentials } from "@/server/inbound-email/aws";

const FRESH_MS = 60 * 1000;

type Fetcher = typeof fetch;

export type SecretPasswordOptions = {
  secretId: string;
  region: string;
  credentials?: () => Promise<AwsCredentials>;
  fetcher?: Fetcher;
  now?: () => number;
};

export function secretRegion(secretId: string, fallback: string) {
  return secretId.startsWith("arn:") ? (secretId.split(":")[3] || fallback) : fallback;
}

export function secretPassword({ secretId, region, credentials = awsCredentials, fetcher = fetch, now = () => Date.now() }: SecretPasswordOptions) {
  let cached: { value: string; at: number } | null = null;
  let pending: Promise<string> | null = null;

  const load = async () => {
    const creds = await credentials();
    const client = new AwsClient({ accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey, sessionToken: creds.sessionToken, region, service: "secretsmanager" });
    const request = await client.sign(`https://secretsmanager.${region}.amazonaws.com/`, {
      method: "POST",
      headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "secretsmanager.GetSecretValue" },
      body: JSON.stringify({ SecretId: secretId }),
    });
    const response = await fetcher(request, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`secretsmanager ${response.status}`);
    const { SecretString } = (await response.json()) as { SecretString?: string };
    if (!SecretString) throw new Error("database secret has no string value");
    const value = SecretString.trimStart().startsWith("{") ? (JSON.parse(SecretString) as { password?: unknown }).password : SecretString;
    if (typeof value !== "string" || !value) throw new Error("database secret has no password");
    cached = { value, at: now() };
    return value;
  };

  return async () => {
    if (cached && now() - cached.at < FRESH_MS) return cached.value;
    pending ??= load().finally(() => {
      pending = null;
    });
    return pending;
  };
}
