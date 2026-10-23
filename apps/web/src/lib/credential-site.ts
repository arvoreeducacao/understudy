export function credentialSite(raw: unknown) {
  const text = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!text) return null;
  const host = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split(/[/?#]/)[0].replace(/:\d+$/, "").replace(/^\*\./, "");
  if (host.length > 253 || !host.includes(".")) return null;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  if (host.split(".").some((label) => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-"))) return null;
  return host;
}

export type ApiKeySend = { sendAs: "bearer" | "scheme" | "header" | "basic" | "query"; field?: string };

export function credentialSendAs(sendAs: unknown, field: unknown): ApiKeySend | null {
  if (sendAs === "bearer" || sendAs === "basic") return { sendAs };
  const name = typeof field === "string" ? field.trim() : "";
  if (sendAs === "scheme" && /^[A-Za-z][A-Za-z0-9._-]{0,31}$/.test(name)) return { sendAs, field: name };
  if (sendAs === "header" && /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(name) && !/^(host|cookie|content-length|transfer-encoding|connection)$/i.test(name)) return { sendAs, field: name };
  if (sendAs === "query" && /^[A-Za-z0-9_.\-\[\]]{1,64}$/.test(name)) return { sendAs, field: name };
  return null;
}

export function credentialTokenPath(raw: unknown): string | null | undefined {
  const path = typeof raw === "string" ? raw.trim() : "";
  if (!path) return undefined;
  return /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]{0,400}$/.test(path) ? path : null;
}
