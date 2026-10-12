export const TELEGRAM_TOKEN = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;
export const TELEGRAM_TEXT_LIMIT = 4096;
export const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1024 * 1024;

type Fetch = typeof fetch;

let fetcher: Fetch = (...args) => fetch(...args);

export function setTelegramFetch(next: Fetch | null) {
  fetcher = next ?? ((...args) => fetch(...args));
}

export function telegramBase(env: NodeJS.ProcessEnv = process.env) {
  return (env.UNDERSTUDY_TELEGRAM_API_URL?.trim() || "https://api.telegram.org").replace(/\/$/, "");
}

export type TelegramResult<T> = { ok: true; result: T } | { ok: false; description?: string; error_code?: number };

export async function telegramCall<T = unknown>(token: string, method: string, body: Record<string, unknown> | FormData = {}): Promise<TelegramResult<T>> {
  const form = body instanceof FormData;
  const response = await fetcher(`${telegramBase()}/bot${token}/${method}`, {
    method: "POST",
    ...(form ? {} : { headers: { "Content-Type": "application/json" } }),
    body: form ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const parsed = (await response.json().catch(() => null)) as TelegramResult<T> | null;
  return parsed ?? { ok: false, description: `http ${response.status}` };
}

export async function telegramDownload(token: string, fileId: string, maxBytes = TELEGRAM_DOWNLOAD_LIMIT): Promise<Buffer | null> {
  const file = await telegramCall<{ file_path?: string; file_size?: number }>(token, "getFile", { file_id: fileId });
  if (!file.ok || !file.result.file_path || (file.result.file_size ?? 0) > maxBytes) return null;
  const response = await fetcher(`${telegramBase()}/file/bot${token}/${file.result.file_path}`, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) return null;
  const data = Buffer.from(await response.arrayBuffer());
  return data.length > maxBytes ? null : data;
}

export function splitText(text: string, limit = TELEGRAM_TEXT_LIMIT) {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const cut = rest.lastIndexOf("\n", limit) > limit / 2 ? rest.lastIndexOf("\n", limit) : limit;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}
