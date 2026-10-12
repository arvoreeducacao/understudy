import { BufferJSON, initAuthCreds, proto, type AuthenticationCreds, type AuthenticationState, type SignalDataSet, type SignalDataTypeMap } from "baileys";
import { and, eq, inArray, like } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { open, seal } from "@/lib/secret-box";

const CREDS = "creds";

function encode(value: unknown) {
  return seal(JSON.stringify(value, BufferJSON.replacer));
}

function decode<T>(sealed: string): T | null {
  try {
    return JSON.parse(open(sealed), BufferJSON.reviver) as T;
  } catch {
    return null;
  }
}

export async function hasWhatsAppSession(channelId: string) {
  const [row] = await getDb()
    .select({ name: schema.channelSecrets.name })
    .from(schema.channelSecrets)
    .where(and(eq(schema.channelSecrets.channelId, channelId), eq(schema.channelSecrets.name, CREDS)));
  return Boolean(row);
}

export async function clearWhatsAppSession(channelId: string) {
  await getDb().delete(schema.channelSecrets).where(eq(schema.channelSecrets.channelId, channelId));
}

async function writeSecret(channelId: string, name: string, value: unknown) {
  const sealed = encode(value);
  await getDb()
    .insert(schema.channelSecrets)
    .values({ channelId, name, value: sealed, updatedAt: new Date() })
    .onConflictDoUpdate({ target: [schema.channelSecrets.channelId, schema.channelSecrets.name], set: { value: sealed, updatedAt: new Date() } });
}

export async function sealedAuthState(channelId: string): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const db = getDb();
  const [stored] = await db
    .select({ value: schema.channelSecrets.value })
    .from(schema.channelSecrets)
    .where(and(eq(schema.channelSecrets.channelId, channelId), eq(schema.channelSecrets.name, CREDS)));
  const creds = (stored ? decode<AuthenticationCreds>(stored.value) : null) ?? initAuthCreds();
  const keys = {
    async get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
      const names = ids.map((id) => `${type}-${id}`);
      const rows = names.length
        ? await db
            .select({ name: schema.channelSecrets.name, value: schema.channelSecrets.value })
            .from(schema.channelSecrets)
            .where(and(eq(schema.channelSecrets.channelId, channelId), inArray(schema.channelSecrets.name, names)))
        : [];
      const found = new Map(rows.map((row) => [row.name, row.value]));
      const data: { [id: string]: SignalDataTypeMap[T] } = {};
      for (const id of ids) {
        const sealed = found.get(`${type}-${id}`);
        let value = sealed ? decode<SignalDataTypeMap[T]>(sealed) : null;
        if (value && type === "app-state-sync-key") value = proto.Message.AppStateSyncKeyData.fromObject(value as object) as unknown as SignalDataTypeMap[T];
        if (value) data[id] = value;
      }
      return data;
    },
    async set(data: SignalDataSet) {
      for (const category of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
        const entries = data[category] ?? {};
        for (const [id, value] of Object.entries(entries)) {
          const name = `${category}-${id}`;
          if (value) await writeSecret(channelId, name, value);
          else await db.delete(schema.channelSecrets).where(and(eq(schema.channelSecrets.channelId, channelId), eq(schema.channelSecrets.name, name)));
        }
      }
    },
    async clear() {
      await db.delete(schema.channelSecrets).where(and(eq(schema.channelSecrets.channelId, channelId), like(schema.channelSecrets.name, "%-%")));
    },
  };
  return { state: { creds, keys }, saveCreds: () => writeSecret(channelId, CREDS, creds) };
}
