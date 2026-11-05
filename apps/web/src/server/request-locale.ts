import { AsyncLocalStorage } from "node:async_hooks";
import { REQUEST_LOCALE_KEY } from "@/lib/messages";

const holder = globalThis as { [REQUEST_LOCALE_KEY]?: AsyncLocalStorage<string | null> };

export const requestLocales = (holder[REQUEST_LOCALE_KEY] ??= new AsyncLocalStorage<string | null>());

const UNLOCALIZED_PREFIXES = ["/_next/static/", "/_next/image", "/_next/webpack-hmr", "/__nextjs"];

export function needsLocale(pathname: string, cookie: string | undefined) {
  return Boolean(cookie) && !UNLOCALIZED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
