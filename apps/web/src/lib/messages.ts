import { en, type Messages } from "./i18n/en";
import { ptBR } from "./i18n/pt-BR";

const dictionaries: Record<string, Messages> = { en, "pt-BR": ptBR };

export const LOCALES = Object.keys(dictionaries);

export const LOCALE_NAMES: Record<string, string> = { en: "English", "pt-BR": "Português (Brasil)" };

export const REQUEST_LOCALE_KEY = Symbol.for("understudy.requestLocale");

type RequestLocaleStore = { getStore(): string | null | undefined };

export function isLocale(value: unknown): value is string {
  return typeof value === "string" && Object.hasOwn(dictionaries, value);
}

export function defaultLocale() {
  const wanted = process.env.UNDERSTUDY_LOCALE?.trim();
  return isLocale(wanted) ? wanted : "en";
}

export function serverLocale() {
  const requested = (globalThis as { [REQUEST_LOCALE_KEY]?: RequestLocaleStore })[REQUEST_LOCALE_KEY]?.getStore();
  return isLocale(requested) ? requested : defaultLocale();
}

export function currentLocale() {
  if (typeof document !== "undefined") return isLocale(document.documentElement.lang) ? document.documentElement.lang : "en";
  return serverLocale();
}

export function localeOr(wanted: string | null | undefined) {
  return isLocale(wanted) ? wanted : defaultLocale();
}

export function messagesFor(locale: string | null | undefined): Messages {
  return dictionaries[localeOr(locale)] ?? en;
}

function dictionary(): Messages {
  return dictionaries[currentLocale()] ?? en;
}

function isSection(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolve(path: readonly string[]): unknown {
  let value: unknown = dictionary();
  for (const key of path) {
    if (!isSection(value)) return undefined;
    value = value[key];
  }
  return value;
}

function section(path: readonly string[]): unknown {
  return new Proxy(
    {},
    {
      get(_, key) {
        if (typeof key === "symbol") {
          const target = resolve(path);
          return isSection(target) ? target[key] : undefined;
        }
        const value = resolve([...path, key]);
        return isSection(value) ? section([...path, key]) : value;
      },
      has(_, key) {
        const target = resolve(path);
        return isSection(target) && key in target;
      },
      ownKeys() {
        const target = resolve(path);
        return isSection(target) ? Reflect.ownKeys(target) : [];
      },
      getOwnPropertyDescriptor(_, key) {
        const target = resolve(path);
        if (!isSection(target) || !Object.hasOwn(target, key)) return undefined;
        const value = target[key];
        return { value: typeof key === "string" && isSection(value) ? section([...path, key]) : value, enumerable: true, configurable: true, writable: false };
      },
    },
  );
}

export const messages = section([]) as Messages;

export type { Messages };
