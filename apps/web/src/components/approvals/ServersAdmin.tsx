"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { addMcpServer, checkMcpServer, removeMcpServer, searchConnectorCatalog, setServerAccess, setServerApprovals } from "@/app/actions/servers";
import { CONNECTOR_PRESETS, type ConnectorPreset } from "@/lib/connector-presets";
import type { CatalogEntry } from "@/lib/mcp-registry";
import { messages } from "@/lib/messages";
import { Checkbox, Field, Input } from "@/components/ui/controls";
import { Segmented } from "@/components/ui/Segmented";

type ServerRow = { id: string; name: string; url: string; tools: string[] | null; askAll: boolean; askTools: string[]; allowedEmails: string[] | null };

function ApprovalRules({ server }: { server: ServerRow }) {
  const t = messages.admin;
  const [askAll, setAskAll] = useState(server.askAll);
  const [askTools, setAskTools] = useState(new Set(server.askTools));
  const [, start] = useTransition();
  const save = (all: boolean, tools: Set<string>) => start(() => setServerApprovals(server.id, all, [...tools]));
  return (
    <div className="flex flex-col gap-2 text-[12.5px]">
      <Checkbox
        className="!text-[12.5px]"
        checked={askAll}
        onChange={(e) => {
          setAskAll(e.target.checked);
          save(e.target.checked, askTools);
        }}
        label={t.serverAskAll}
      />
      {!askAll && server.tools && server.tools.length > 0 && (
        <div className="flex flex-wrap gap-x-5 gap-y-2 pl-7">
          {server.tools.map((tool) => (
            <Checkbox
              key={tool}
              className="!text-[12.5px]"
              checked={askTools.has(tool)}
              onChange={() => {
                const next = new Set(askTools);
                if (next.has(tool)) next.delete(tool);
                else next.add(tool);
                setAskTools(next);
                save(askAll, next);
              }}
              label={<span className="font-mono">{tool}</span>}
            />
          ))}
        </div>
      )}
      {!askAll && server.tools && server.tools.length > 0 && <div className="fld-hint pl-7">{t.serverAskHint}</div>}
    </div>
  );
}

function AccessRules({ server }: { server: ServerRow }) {
  const t = messages.admin;
  const [everyone, setEveryone] = useState(server.allowedEmails === null);
  const [emails, setEmails] = useState((server.allowedEmails ?? []).join(", "));
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  const save = (all: boolean, list: string) =>
    start(async () => {
      await setServerAccess(server.id, all, list);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    });
  return (
    <div className="flex flex-col gap-2 text-[12.5px]">
      <div className="flex gap-3 flex-wrap items-center">
        <Segmented
          label={t.serverAccess}
          options={[
            { value: "all", label: t.serverEveryone },
            { value: "some", label: t.serverOnly },
          ]}
          value={everyone ? "all" : "some"}
          onChange={(choice) => {
            if (choice === "all") {
              setEveryone(true);
              save(true, emails);
            } else setEveryone(false);
          }}
        />
        {saved && <span className="text-green">{t.serverSaved}</span>}
      </div>
      {!everyone && (
        <div className="flex gap-2">
          <Input size="sm" placeholder={t.serverEmails} aria-label={t.serverEmails} value={emails} onChange={(e) => setEmails(e.target.value)} />
          <button type="button" className="btn sec sm" disabled={pending} onClick={() => save(false, emails)}>
            {t.serverSave}
          </button>
        </div>
      )}
    </div>
  );
}

function CheckAgain({ id }: { id: string }) {
  const t = messages.admin;
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <>
      {result && <span className={`text-[12px] ${result.ok ? "text-green" : "text-coral"}`}>{result.message}</span>}
      <button type="button" className="btn sec sm" disabled={pending} onClick={() => start(async () => setResult(await checkMcpServer(id)))}>
        {pending ? t.serverChecking : t.serverCheck}
      </button>
    </>
  );
}

function ToolList({ tools }: { tools: string[] }) {
  const t = messages.admin;
  if (!tools.length) return null;
  return (
    <details className="text-[12.5px]">
      <summary className="cursor-pointer text-ash">{t.serverSeeTools(tools.length)}</summary>
      <div className="flex flex-wrap gap-1.5 pt-2">
        {tools.map((tool) => (
          <span key={tool} className="pill font-mono">
            {tool}
          </span>
        ))}
      </div>
    </details>
  );
}

function withPrefix(value: string, prefix?: string) {
  const key = value.trim();
  if (!key || !prefix || key.toLowerCase().startsWith(prefix.trim().toLowerCase())) return key;
  return `${prefix}${key}`;
}

function fromCatalog(entry: CatalogEntry): ConnectorPreset {
  return { id: entry.id, name: entry.name, url: entry.url, headerName: entry.headerName, headerPrefix: entry.headerPrefix, keyPage: entry.headerName ? entry.website : undefined };
}

function CatalogSearch({ picked, onPick }: { picked: string | null; onPick: (choice: ConnectorPreset) => void }) {
  const t = messages.admin;
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{ query: string; entries: CatalogEntry[] | null } | null>(null);
  const [pending, start] = useTransition();
  useEffect(() => {
    const wanted = query.trim();
    if (wanted.length < 2) {
      setResult(null);
      return;
    }
    const timer = setTimeout(() => {
      start(async () => {
        const found = await searchConnectorCatalog(wanted);
        setResult({ query: wanted, entries: found.ok ? found.entries : null });
      });
    }, 350);
    return () => clearTimeout(timer);
  }, [query]);
  const searching = query.trim().length >= 2;
  return (
    <div className="flex flex-col gap-2">
      <Field label={t.catalogLabel} hint={t.catalogHint}>
        <Input type="search" value={query} placeholder={t.catalogPlaceholder} autoComplete="off" maxLength={60} onChange={(e) => setQuery(e.target.value)} />
      </Field>
      {!searching && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] text-smoke">{t.catalogPopular}</span>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t.catalogPopular}>
            {CONNECTOR_PRESETS.map((choice) => (
              <button key={choice.id} type="button" className={`btn sm ${picked === choice.id ? "pri" : "sec"}`} aria-pressed={picked === choice.id} onClick={() => onPick(choice)}>
                {choice.name}
              </button>
            ))}
          </div>
        </div>
      )}
      {searching && (
        <div aria-live="polite" className="flex flex-col gap-1.5">
          {(pending || !result || result.query !== query.trim()) && <span className="text-[12.5px] text-smoke">{t.catalogSearching}</span>}
          {!pending && result?.query === query.trim() && result.entries === null && <span className="text-[12.5px] text-coral">{t.catalogFailed}</span>}
          {!pending && result?.query === query.trim() && result.entries?.length === 0 && <span className="text-[12.5px] text-smoke">{t.catalogEmpty}</span>}
          {result?.entries && result.entries.length > 0 && (
            <ul className="cat-list" aria-label={t.catalogLabel}>
              {result.entries.map((entry) => (
                <li key={entry.id}>
                  <button type="button" className="cat-item" aria-pressed={picked === entry.id} onClick={() => onPick(fromCatalog(entry))}>
                    <span className="cat-head">
                      <span className="cat-name">{entry.name}</span>
                      <span className={`pill ${entry.publisher.kind === "domain" ? "g" : ""}`}>
                        {entry.publisher.kind === "domain" ? t.catalogVerified(entry.publisher.label) : t.catalogGithub(entry.publisher.label)}
                      </span>
                    </span>
                    {entry.description && <span className="cat-desc">{entry.description}</span>}
                    <span className="cat-url">{new URL(entry.url).host}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function AddConnector() {
  const t = messages.admin;
  const [state, action, pending] = useActionState(addMcpServer, null);
  const [fields, setFields] = useState({ name: "", url: "", headerName: "", headerValue: "" });
  const [preset, setPreset] = useState<ConnectorPreset | null>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<typeof fields>) => setFields((current) => ({ ...current, ...patch }));

  useEffect(() => {
    if (!state?.ok) return;
    setFields({ name: "", url: "", headerName: "", headerValue: "" });
    setPreset(null);
  }, [state]);

  const pick = (choice: ConnectorPreset) => {
    setPreset(choice);
    setFields({ name: choice.name, url: choice.url, headerName: choice.headerName ?? "", headerValue: "" });
    if (choice.headerName) setTimeout(() => keyRef.current?.focus(), 0);
  };

  return (
    <form action={action} className="flex flex-col gap-3 border-t border-graphite pt-3">
      <h3 className="m-0 text-[13px] font-semibold">{t.serverAddTitle}</h3>
      <CatalogSearch picked={preset?.id ?? null} onPick={pick} />
      <div className="grid grid-cols-2 gap-2.5 max-[800px]:grid-cols-1">
        <Input name="name" placeholder={t.serverName} aria-label={t.serverName} required value={fields.name} onChange={(e) => set({ name: e.target.value })} />
        <Input name="url" className="font-mono" placeholder={t.serverUrl} aria-label={t.serverUrl} required value={fields.url} onChange={(e) => set({ url: e.target.value })} />
        <Input name="headerName" className="font-mono" placeholder={t.serverHeaderName} aria-label={t.serverHeaderName} value={fields.headerName} onChange={(e) => set({ headerName: e.target.value })} />
        <input type="hidden" name="headerValue" value={withPrefix(fields.headerValue, preset?.headerPrefix)} />
        <Input
          ref={keyRef}
          type="password"
          className="font-mono"
          placeholder={preset?.headerName ? t.presetKeyPlaceholder : t.serverHeaderValue}
          aria-label={t.serverHeaderValue}
          autoComplete="off"
          value={fields.headerValue}
          onChange={(e) => set({ headerValue: e.target.value })}
        />
      </div>
      {preset && (
        <div className="fld-hint">
          {preset.headerName ? t.presetKeyHint(preset.headerPrefix ?? "") : CONNECTOR_PRESETS.some((known) => known.id === preset.id) ? t.presetNoKey : t.catalogNoKey}{" "}
          {preset.keyPage && (
            <a href={preset.keyPage} target="_blank" rel="noreferrer" className="underline">
              {t.presetKeyPage(preset.name)}
            </a>
          )}
        </div>
      )}
      <div className="flex items-center gap-3 flex-wrap">
        <button type="submit" className="btn pri" disabled={pending}>
          {pending ? t.serverTesting : t.serverAdd}
        </button>
        {state?.message && (
          <span role="status" className={`text-[12.5px] ${state.ok ? "text-green" : "text-coral"}`}>
            {state.message}
          </span>
        )}
      </div>
    </form>
  );
}

export function ServersAdmin({ servers }: { servers: ServerRow[] }) {
  const t = messages.admin;
  const [removing, startRemove] = useTransition();
  return (
    <section id="connected-tools" className="card p-5 flex flex-col gap-3 scroll-mt-6">
      {servers.length === 0 && <div className="text-smoke text-[13px]">{t.noServersYet}</div>}
      {servers.map((server) => (
        <div key={server.id} className="flex flex-col gap-2 border-t border-graphite pt-2.5">
          <div className="flex items-center gap-3 text-[13px] flex-wrap">
            <div className="min-w-0 flex-1">
              <div className="truncate">{server.name}</div>
              <div className="text-smoke text-[12px] truncate font-mono">{server.url}</div>
            </div>
            <span className={`pill ${server.tools === null ? "c" : ""}`}>{server.tools === null ? t.serverDown : t.serverTools(server.tools.length)}</span>
            <CheckAgain id={server.id} />
            <button className="btn sec sm" disabled={removing} onClick={() => startRemove(() => removeMcpServer(server.id))}>
              {t.serverRemove}
            </button>
          </div>
          {server.tools && <ToolList tools={server.tools} />}
          <AccessRules server={server} />
          <ApprovalRules server={server} />
        </div>
      ))}
      <AddConnector />
    </section>
  );
}
