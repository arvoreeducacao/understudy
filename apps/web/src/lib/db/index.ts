import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { rdsIamPassword, secretPassword, secretRegion } from "./password";
import * as schema from "./schema";

type Db = NodePgDatabase<typeof schema>;

const store = globalThis as unknown as { __understudyDb?: { pool: pg.Pool; db: Db } };

function passwordSource(): (() => Promise<string>) | undefined {
  const region = process.env.AWS_REGION?.trim() || "us-east-1";
  if (process.env.DATABASE_IAM_AUTH?.trim() === "true") {
    const url = new URL(process.env.DATABASE_URL ?? "");
    return rdsIamPassword({ host: url.hostname, port: Number(url.port || 5432), user: decodeURIComponent(url.username), region });
  }
  const secretId = process.env.DATABASE_PASSWORD_SECRET_ARN?.trim();
  if (!secretId) return undefined;
  return secretPassword({ secretId, region: secretRegion(secretId, region) });
}

function clientClass(): typeof pg.Client | undefined {
  const password = passwordSource();
  if (!password) return undefined;
  return class extends pg.Client {
    constructor(config?: string | pg.ClientConfig) {
      super(config);
      Object.assign(this, { password });
    }
  };
}

function create() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10, Client: clientClass() });
  return { pool, db: drizzle(pool, { schema }) };
}

export function getDb(): Db {
  store.__understudyDb ??= create();
  return store.__understudyDb.db;
}

export function getPool(): pg.Pool {
  store.__understudyDb ??= create();
  return store.__understudyDb.pool;
}

export { schema };
