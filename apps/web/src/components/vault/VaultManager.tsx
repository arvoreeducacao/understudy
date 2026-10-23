import { useState } from "react";
import type { AgentLink } from "@/components/live/useAgentSocket";
import type { CredentialInfo } from "@/lib/db/schema";
import { ConfirmButton } from "@/components/ConfirmButton";
import { messages } from "@/lib/messages";
import { Input } from "@/components/ui/controls";
import { EmptyState } from "@/components/ui/EmptyState";
import type { Look } from "@/lib/look";

type Kind = "login" | "api_key";

type SendAs = NonNullable<CredentialInfo["sendAs"]>;

const SEND_AS: SendAs[] = ["bearer", "scheme", "header", "basic", "query"];

const FIELD_PATTERN: Partial<Record<SendAs, string>> = {
  scheme: "[A-Za-z][A-Za-z0-9._\\-]{0,31}",
  header: "[A-Za-z0-9][A-Za-z0-9\\-]{0,63}",
  query: "[A-Za-z0-9_.\\-\\[\\]]{1,64}",
};

function sentAs(c: CredentialInfo): string {
  if (c.tokenPath) return `token ${c.tokenPath} · Bearer`;
  if (c.sendAs === "scheme") return `Authorization: ${c.field}`;
  if (c.sendAs === "header") return `${c.field}:`;
  if (c.sendAs === "basic") return `Basic ${c.username}:`;
  if (c.sendAs === "query") return `?${c.field}=`;
  return "Authorization: Bearer";
}

function Choices<T extends string>({ label, options, value, names, onChange }: { label: string; options: T[]; value: T; names: Record<T, string>; onChange: (value: T) => void }) {
  return (
    <div className="choices" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option} type="button" className={`choice ${value === option ? "is-on" : ""}`} aria-pressed={value === option} onClick={() => onChange(option)}>
          {names[option]}
        </button>
      ))}
    </div>
  );
}

export function VaultManager({ link, credentials, look }: { link: Pick<AgentLink, "live" | "send">; credentials: CredentialInfo[]; look?: Look }) {
  const t = messages.vault;
  const { live, send } = link;
  const [notice, setNotice] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>("login");
  const [sendAs, setSendAs] = useState<SendAs>("bearer");
  const apiKey = kind === "api_key";
  const named = apiKey && (sendAs === "scheme" || sendAs === "header" || sendAs === "query");
  const fieldLabel = sendAs === "scheme" ? t.schemeName : sendAs === "header" ? t.headerName : t.queryName;

  return (
    <div className="ws-panel">
      <p className="ws-lead">{t.subtitle}</p>
      <div className="grid grid-cols-[minmax(0,1fr)_340px] gap-4 @max-[760px]:grid-cols-1">
        <div className="card p-[18px] flex flex-col self-start min-w-0">
          {credentials.length === 0 && <EmptyState size="sm" look={look} mood="calm" title={messages.empty.loginsTitle} body={messages.empty.loginsBody} />}
          {credentials.map((c) => (
            <div key={c.name} className="flex items-center gap-3 border-t border-graphite py-2.5 first:border-0 text-[13px]">
              <div className="min-w-0 flex-1">
                <div className="font-mono truncate">
                  {c.name}
                  {c.kind === "api_key" && <span className="ml-2 font-sans text-[11px] text-smoke">{t.kindApiKey}</span>}
                </div>
                <div className="text-smoke text-[12px] truncate">
                  {c.kind === "api_key" ? `${c.site} · ${sentAs(c)} ••••••••` : `${c.username}${c.site ? ` · ${c.site}` : ""} · ••••••••`}
                </div>
              </div>
              <ConfirmButton
                label={t.remove}
                question={t.confirmRemove(c.name)}
                disabled={!live.online}
                onConfirm={() => send({ type: "credential_delete", name: c.name })}
              />
            </div>
          ))}
        </div>
        <form
          className="card p-[18px] flex flex-col gap-2.5 self-start"
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const data = new FormData(form);
            const name = String(data.get("name") ?? "").trim();
            const secret = String(data.get("secret") ?? "");
            if (!name || !secret) return;
            const ok = send({
              type: "credential_set",
              name,
              username: String(data.get("username") ?? "").trim(),
              secret,
              site: String(data.get("site") ?? "").trim() || undefined,
              ...(apiKey
                ? { kind: "api_key" as const, sendAs, field: named ? String(data.get("field") ?? "").trim() : undefined, tokenPath: String(data.get("tokenPath") ?? "").trim() || undefined }
                : {}),
            });
            if (ok) {
              form.reset();
              setNotice(t.saved(name));
            }
          }}
        >
          <Choices label={t.kindLabel} options={["login", "api_key"] as Kind[]} value={kind} names={{ login: t.kindLogin, api_key: t.kindApiKey }} onChange={setKind} />
          <Input name="name" className="font-mono" placeholder={apiKey ? t.keyNamePlaceholder : t.namePlaceholder} aria-label={t.name} required pattern="[A-Za-z0-9 .@_\-]{1,64}" maxLength={64} />
          {(!apiKey || sendAs === "basic") && <Input name="username" placeholder={t.username} aria-label={t.username} autoComplete="off" required={apiKey} />}
          <Input name="secret" type="password" placeholder={apiKey ? t.apiKey : t.secret} aria-label={apiKey ? t.apiKey : t.secret} autoComplete="new-password" required />
          <Input name="site" placeholder={apiKey ? t.apiSite : t.site} aria-label={apiKey ? t.apiSite : t.site} required />
          {apiKey && (
            <>
              <div className="text-[11.5px] text-smoke">{t.sendAsLabel}</div>
              <Choices label={t.sendAsLabel} options={SEND_AS} value={sendAs} names={t.sendAs} onChange={setSendAs} />
              {named && (
                <Input key={sendAs} name="field" className="font-mono" placeholder={fieldLabel} aria-label={fieldLabel} required pattern={FIELD_PATTERN[sendAs]} maxLength={64} />
              )}
              <Input name="tokenPath" className="font-mono" placeholder={t.tokenPath} aria-label={t.tokenPath} pattern="/[^\s#]{0,400}" maxLength={401} />
            </>
          )}
          <div className="text-[11.5px] text-smoke">
            {t.replaceHint}
            {apiKey && ` ${t.apiHint}`}
          </div>
          <button type="submit" className="btn pri self-start" disabled={!live.online}>
            {apiKey ? t.addKey : t.add}
          </button>
          {!live.online && <div className="text-smoke text-[12px]">{t.offline}</div>}
          {notice && <div className="text-green text-[12.5px]">{notice}</div>}
        </form>
      </div>
    </div>
  );
}
