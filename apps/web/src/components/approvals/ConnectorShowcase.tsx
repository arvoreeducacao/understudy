"use client";

import { useActionState, useEffect, useRef, useState, useTransition, type CSSProperties } from "react";
import { ArrowUpRight, Check, Search, X } from "lucide-react";
import { addMcpServer, searchConnectorCatalog, type AddServerState } from "@/app/actions/servers";
import { catalogExtras, filterFeatured, monogram, sameAddress, SHOWCASE_CATEGORIES, tintOf, withPrefix, type Connector, type ShowcaseCategory } from "@/lib/connector-showcase";
import type { CatalogEntry } from "@/lib/mcp-registry";
import { messages } from "@/lib/messages";
import { Field, Input } from "@/components/ui/controls";
import { Segmented } from "@/components/ui/Segmented";

export function ConnectorLogo({ name, icon, size = 40 }: { name: string; icon?: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  const style = { "--logo-tint": tintOf(name), width: size, height: size } as CSSProperties;
  if (icon && !broken)
    return (
      <span className="conn-logo has-img" style={style} aria-hidden>
        <img src={icon} alt="" referrerPolicy="no-referrer" loading="lazy" onError={() => setBroken(true)} />
      </span>
    );
  return (
    <span className="conn-logo" style={style} aria-hidden>
      {monogram(name)}
    </span>
  );
}

function publisherLine(connector: Connector) {
  const t = messages.admin;
  return connector.publisher.kind === "domain" ? t.catalogVerified(connector.publisher.label) : t.catalogGithub(connector.publisher.label);
}

function ConnectorTile({ connector, blurb, connected, onPick }: { connector: Connector; blurb?: string; connected: boolean; onPick: () => void }) {
  const t = messages.admin;
  return (
    <li>
      <button type="button" className="conn-tile" disabled={connected} onClick={onPick} aria-label={connected ? `${connector.name}, ${t.showcaseConnected}` : t.showcaseOpen(connector.name)}>
        <span className="flex items-center gap-3 min-w-0">
          <ConnectorLogo name={connector.name} icon={connector.icon} />
          <span className="min-w-0 flex-1">
            <span className="conn-name">{connector.name}</span>
            <span className="conn-by">{publisherLine(connector)}</span>
          </span>
        </span>
        {(blurb ?? connector.description) && <span className="conn-desc">{blurb ?? connector.description}</span>}
        {connected && (
          <span className="pill g w-fit">
            <Check size={12} aria-hidden />
            {t.showcaseConnected}
          </span>
        )}
      </button>
    </li>
  );
}

function ConnectSheet({
  connector,
  blurb,
  state,
  action,
  pending,
  onClose,
}: {
  connector: Connector | null;
  blurb?: string;
  state: AddServerState;
  action: (form: FormData) => void;
  pending: boolean;
  onClose: () => void;
}) {
  const t = messages.admin;
  const ref = useRef<HTMLDialogElement | null>(null);
  const keyRef = useRef<HTMLInputElement | null>(null);
  const [key, setKey] = useState("");
  const [wantsKey, setWantsKey] = useState(false);
  const [attempted, setAttempted] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (connector && !dialog.open) dialog.showModal();
    if (!connector && dialog.open) dialog.close();
    setKey("");
    setWantsKey(false);
    setAttempted(false);
    if (connector?.headerName) setTimeout(() => keyRef.current?.focus(), 0);
  }, [connector]);

  const needsKey = Boolean(connector?.headerName);
  const headerName = connector?.headerName ?? (wantsKey ? "Authorization" : "");
  const prefix = connector?.headerPrefix ?? (wantsKey ? "Bearer " : undefined);
  const showKey = needsKey || wantsKey;
  const failure = attempted && !pending && state && !state.ok ? state.message : null;

  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-labelledby="connect-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {connector && (
        <form
          className="sheet-body"
          action={(form) => {
            setAttempted(true);
            action(form);
          }}
        >
          <div className="flex items-center gap-3">
            <ConnectorLogo name={connector.name} icon={connector.icon} size={48} />
            <div className="min-w-0 flex-1">
              <h2 id="connect-title" className="m-0 text-[16px] font-semibold">
                {t.connectTitle(connector.name)}
              </h2>
              <p className="m-0 text-smoke text-[12.5px]">{publisherLine(connector)}</p>
            </div>
            <button type="button" className="cx-back" aria-label={messages.common.close} onClick={onClose}>
              <X size={17} aria-hidden />
            </button>
          </div>
          {(blurb ?? connector.description) && <p className="m-0 text-[13px] leading-relaxed text-ash">{blurb ?? connector.description}</p>}
          {connector.publisher.kind === "github" && <p className="conn-note m-0">{t.connectCommunity}</p>}
          <input type="hidden" name="name" value={connector.name} />
          <input type="hidden" name="url" value={connector.url} />
          <input type="hidden" name="headerName" value={showKey ? headerName : ""} />
          <input type="hidden" name="headerValue" value={showKey ? withPrefix(key, prefix) : ""} />
          {showKey ? (
            <Field
              label={needsKey ? t.connectKeyLabel(connector.name) : t.connectOptionalKeyLabel}
              hint={
                <>
                  {t.connectKeySafe}{" "}
                  {connector.keyPage && (
                    <a href={connector.keyPage} target="_blank" rel="noreferrer" className="conn-link">
                      {t.connectKeyWhere(connector.name)}
                      <ArrowUpRight size={12} aria-hidden />
                    </a>
                  )}
                </>
              }
            >
              <Input
                ref={keyRef}
                type="password"
                className="font-mono"
                placeholder={t.presetKeyPlaceholder}
                autoComplete="off"
                spellCheck={false}
                required={needsKey}
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
            </Field>
          ) : (
            <div className="conn-ready">
              <Check size={15} aria-hidden />
              <span>{connector.featured ? t.connectNoKey : t.connectCatalogNoKey}</span>
              {!connector.featured && (
                <button type="button" className="conn-link ml-auto" onClick={() => setWantsKey(true)}>
                  {t.connectHasKey}
                </button>
              )}
            </div>
          )}
          <details className="conn-details">
            <summary>{t.connectDetails}</summary>
            <div className="pt-1.5 font-mono text-[11.5px] text-smoke break-all">{connector.url}</div>
          </details>
          {failure && (
            <p role="alert" className="m-0 text-[12.5px] text-coral">
              {failure}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn sec sm" onClick={onClose}>
              {t.connectCancel}
            </button>
            <button type="submit" className="btn pri sm" disabled={pending || (needsKey && !key.trim())}>
              {pending ? t.serverTesting : t.connectGo}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}

function ManualAdd() {
  const t = messages.admin;
  const [state, action, pending] = useActionState(addMcpServer, null);
  const [fields, setFields] = useState({ name: "", url: "", headerName: "", headerValue: "" });
  const set = (patch: Partial<typeof fields>) => setFields((current) => ({ ...current, ...patch }));

  useEffect(() => {
    if (state?.ok) setFields({ name: "", url: "", headerName: "", headerValue: "" });
  }, [state]);

  return (
    <details className="conn-details">
      <summary>{t.manualTitle}</summary>
      <form action={action} className="flex flex-col gap-3 pt-3">
        <p className="m-0 fld-hint">{t.manualHint}</p>
        <div className="grid grid-cols-2 gap-2.5 max-[800px]:grid-cols-1">
          <Input name="name" placeholder={t.serverName} aria-label={t.serverName} required value={fields.name} onChange={(e) => set({ name: e.target.value })} />
          <Input name="url" className="font-mono" placeholder={t.serverUrl} aria-label={t.serverUrl} required value={fields.url} onChange={(e) => set({ url: e.target.value })} />
          <Input
            name="headerName"
            className="font-mono"
            placeholder={t.serverHeaderName}
            aria-label={t.serverHeaderName}
            value={fields.headerName}
            onChange={(e) => set({ headerName: e.target.value })}
          />
          <Input
            name="headerValue"
            type="password"
            className="font-mono"
            placeholder={t.serverHeaderValue}
            aria-label={t.serverHeaderValue}
            autoComplete="off"
            value={fields.headerValue}
            onChange={(e) => set({ headerValue: e.target.value })}
          />
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <button type="submit" className="btn sec sm" disabled={pending}>
            {pending ? t.serverTesting : t.serverAdd}
          </button>
          {state?.message && (
            <span role="status" className={`text-[12.5px] ${state.ok ? "text-green" : "text-coral"}`}>
              {state.message}
            </span>
          )}
        </div>
      </form>
    </details>
  );
}

function useCatalog(query: string) {
  const [result, setResult] = useState<{ query: string; entries: CatalogEntry[] | null } | null>(null);
  const [pending, start] = useTransition();
  const wanted = query.trim();
  useEffect(() => {
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
  }, [wanted]);
  const fresh = result?.query === wanted ? result : null;
  return { searching: wanted.length >= 2, loading: wanted.length >= 2 && (pending || !fresh), entries: fresh?.entries ?? [], failed: fresh?.entries === null };
}

export function ConnectorShowcase({ connectedUrls }: { connectedUrls: string[] }) {
  const t = messages.admin;
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<ShowcaseCategory | "all">("all");
  const [picked, setPicked] = useState<Connector | null>(null);
  const [state, action, pending] = useActionState(addMcpServer, null);
  const [notice, setNotice] = useState<string | null>(null);
  const catalog = useCatalog(query);
  const blurbs = t.showcaseBlurbs as Partial<Record<string, string>>;

  useEffect(() => {
    if (!state?.ok) return;
    setNotice(state.message);
    setPicked(null);
  }, [state]);

  const featured = filterFeatured(query, catalog.searching ? "all" : category, blurbs);
  const extras = catalog.searching ? catalogExtras(catalog.entries, featured) : [];
  const isConnected = (connector: Connector) => connectedUrls.some((url) => sameAddress(url, connector.url));
  const pick = (connector: Connector) => {
    setNotice(null);
    setPicked(connector);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="m-0 text-[14px] font-semibold">{t.showcaseTitle}</h3>
        <p className="m-0 text-[12.5px] text-smoke">{t.showcaseHint}</p>
      </div>
      {notice && (
        <p role="status" className="m-0 text-[12.5px] text-green">
          {notice}
        </p>
      )}
      <div className="conn-search">
        <Search size={15} aria-hidden />
        <Input type="search" value={query} placeholder={t.catalogPlaceholder} aria-label={t.catalogLabel} autoComplete="off" maxLength={60} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {!catalog.searching && (
        <Segmented
          variant="chips"
          label={t.showcaseCategories}
          value={category}
          onChange={setCategory}
          options={[{ value: "all" as const, label: t.showcaseAll }, ...SHOWCASE_CATEGORIES.map((value) => ({ value, label: t.showcaseCategory[value] }))]}
        />
      )}
      {featured.length > 0 && (
        <ul className="conn-grid" aria-label={catalog.searching ? t.showcaseFeatured : t.showcaseTitle}>
          {featured.map((connector) => (
            <ConnectorTile key={connector.id} connector={connector} blurb={blurbs[connector.id]} connected={isConnected(connector)} onPick={() => pick(connector)} />
          ))}
        </ul>
      )}
      {catalog.searching && (
        <div aria-live="polite" className="flex flex-col gap-2">
          <span className="text-[12px] text-smoke">{t.showcaseFromCatalog}</span>
          {catalog.loading && extras.length === 0 && <span className="text-[12.5px] text-smoke">{t.catalogSearching}</span>}
          {!catalog.loading && catalog.failed && <span className="text-[12.5px] text-coral">{t.catalogFailed}</span>}
          {!catalog.loading && !catalog.failed && extras.length === 0 && featured.length === 0 && <span className="text-[12.5px] text-smoke">{t.catalogEmpty}</span>}
          {!catalog.loading && !catalog.failed && extras.length === 0 && featured.length > 0 && <span className="text-[12.5px] text-smoke">{t.showcaseNoMore}</span>}
          {extras.length > 0 && (
            <ul className="conn-grid" aria-label={t.showcaseFromCatalog}>
              {extras.map((connector) => (
                <ConnectorTile key={connector.id} connector={connector} blurb={blurbs[connector.id]} connected={isConnected(connector)} onPick={() => pick(connector)} />
              ))}
            </ul>
          )}
        </div>
      )}
      <ManualAdd />
      <ConnectSheet connector={picked} blurb={picked ? blurbs[picked.id] : undefined} state={state} action={action} pending={pending} onClose={() => setPicked(null)} />
    </div>
  );
}
