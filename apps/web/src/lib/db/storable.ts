const NUL = /\u0000/g;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

const REPLACEMENT = "\uFFFD";

export function storableText(text: string): string {
  return text.replace(NUL, REPLACEMENT).replace(LONE_SURROGATE, REPLACEMENT);
}

export function storableJson<T>(value: T): T {
  if (typeof value === "string") return storableText(value) as T;
  if (Array.isArray(value)) return value.map((item) => storableJson(item)) as T;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [storableText(key), storableJson(item)])) as T;
  }
  return value;
}
