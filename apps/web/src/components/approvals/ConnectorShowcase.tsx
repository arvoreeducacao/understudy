"use client";

import { useActionState, useEffect, useState, useTransition, type CSSProperties } from "react";
import { ArrowUpRight, Check, Plus, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { addMcpServer, searchConnectorCatalog, type AddServerState } from "@/app/actions/servers";
import { catalogExtras, connectorHref, publisherLine, CUSTOM_CONNECTOR, filterFeatured, logoSources, monogram, sameAddress, SHOWCASE_CATEGORIES, tintOf, withPrefix, type Connector, type ShowcaseCategory } from "@/lib/connector-showcase";
import type { CatalogEntry } from "@/lib/mcp-registry";
import { messages } from "@/lib/messages";
import { Field, Input } from "@/components/ui/controls";
import { Segmented } from "@/components/ui/Segmented";

export function ConnectorLogo({ connector, size = 40 }: { connector: Pick<Connector, "name" | "icon" | "publisher" | "url">; size?: number }) {
  const sources = logoSources(connector);
  const [failed, setFailed] = useState(0);
  const name = connector.name;
  const style = { "--logo-tint": tintOf(name), width: size, height: size } as CSSProperties;
  const source = sources[failed];
  if (source)
    return (
      <span className="conn-logo has-img" style={style} aria-hidden>
        <img key={source} src={source} alt="" referrerPolicy="no-referrer" loading="lazy" onError={() => setFailed((count) => count + 1)} />
      </span>
    );
  return (
    <span className="conn-logo" style={style} aria-hidden>
      {monogram(name)}
    </span>
  );
}

function ConnectorTile({ connector, blurb, connected, query }: { connector: Connector; blurb?: string; connected: boolean; query?: string }) {
  const t = messages.admin;
  return (
    <li>
      <Link href={connectorHref(connector, query)} className="conn-tile" aria-label={connected ? `${connector.name}, ${t.showcaseConnected}` : t.showcaseOpen(connector.name)}>
        <span className="flex items-center gap-3 min-w-0">
          <ConnectorLogo connector={connector} />
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
      </Link>
    </li>
  );
}

export function ConnectForm({ connector }: { connector: Connector }) {
  const t = messages.admin;
  const router = useRouter();
  const [state, action, pending] = useActionState(addMcpServer, null);
  const [key, setKey] = useState("");
  const [wantsKey, setWantsKey] = useState(false);

  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);

  const needsKey = Boolean(connector.headerName);
  const headerName = connector.headerName ?? (wantsKey ? "Authorization" : "");
  const prefix = connector.headerPrefix ?? (wantsKey ? "Bearer " : undefined);
  const showKey = needsKey || wantsKey;
  const failure = !pending && state && !state.ok ? state.message : null;

  return (
    <form className="card conn-panel" action={action}>
      <h2 className="m-0 text-[15px] font-semibold">{t.connectTitle(connector.name)}</h2>
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
            type="password"
            className="font-mono"
            placeholder={t.presetKeyPlaceholder}
            autoComplete="off"
            spellCheck={false}
            autoFocus={needsKey}
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
      {failure && (
        <p role="alert" className="m-0 text-[12.5px] text-coral">
          {failure}
        </p>
      )}
      <div className="flex items-center gap-3 flex-wrap">
        <button type="submit" className="btn pri" disabled={pending || (needsKey && !key.trim())}>
          {pending ? t.serverTesting : t.connectGo}
        </button>
      </div>
      <details className="conn-details">
        <summary>{t.connectDetails}</summary>
        <div className="pt-1.5 font-mono text-[11.5px] text-smoke break-all">{connector.url}</div>
      </details>
    </form>
  );
}

export function ManualConnectForm() {
  const t = messages.admin;
  const router = useRouter();
  const [state, action, pending] = useActionState(addMcpServer, null);
  const [fields, setFields] = useState({ name: "", url: "", headerName: "", headerValue: "" });
  const set = (patch: Partial<typeof fields>) => setFields((current) => ({ ...current, ...patch }));

  useEffect(() => {
    if (state?.ok && state.id) router.push(`/admin/connectors/${state.id}`);
  }, [state, router]);

  return (
    <form action={action} className="card conn-panel">
      <Field label={t.serverName}>
        <Input name="name" placeholder={t.manualNamePlaceholder} required autoFocus value={fields.name} onChange={(e) => set({ name: e.target.value })} />
      </Field>
      <Field label={t.serverUrl} hint={t.manualUrlHint}>
        <Input name="url" className="font-mono" placeholder="https://example.com/mcp" required value={fields.url} onChange={(e) => set({ url: e.target.value })} />
      </Field>
      <div className="grid grid-cols-2 gap-3 max-[640px]:grid-cols-1">
        <Field label={t.serverHeaderName}>
          <Input name="headerName" className="font-mono" placeholder="Authorization" value={fields.headerName} onChange={(e) => set({ headerName: e.target.value })} />
        </Field>
        <Field label={t.serverHeaderValue}>
          <Input
            name="headerValue"
            type="password"
            className="font-mono"
            placeholder="Bearer …"
            autoComplete="off"
            value={fields.headerValue}
            onChange={(e) => set({ headerValue: e.target.value })}
          />
        </Field>
      </div>
      <p className="m-0 fld-hint">{t.connectKeySafe}</p>
      {state && !state.ok && !pending && (
        <p role="alert" className="m-0 text-[12.5px] text-coral">
          {state.message}
        </p>
      )}
      <div>
        <button type="submit" className="btn pri" disabled={pending}>
          {pending ? t.serverTesting : t.connectGo}
        </button>
      </div>
    </form>
  );
}

function ManualCta() {
  const t = messages.admin;
  return (
    <Link href={`/admin/connectors/${CUSTOM_CONNECTOR}`} className="conn-custom">
      <span className="conn-custom-icon" aria-hidden>
        <Plus size={20} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-semibold text-white">{t.manualCtaTitle}</span>
        <span className="block text-[12.5px] text-ash">{t.manualCtaBody}</span>
      </span>
      <span className="btn pri sm flex-none max-[480px]:hidden">{t.manualTitle}</span>
    </Link>
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
  const catalog = useCatalog(query);
  const blurbs = t.showcaseBlurbs as Partial<Record<string, string>>;

  const featured = filterFeatured(query, catalog.searching ? "all" : category, blurbs);
  const extras = catalog.searching ? catalogExtras(catalog.entries, featured) : [];
  const isConnected = (connector: Connector) => connectedUrls.some((url) => sameAddress(url, connector.url));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="m-0 text-[14px] font-semibold">{t.showcaseTitle}</h3>
        <p className="m-0 text-[12.5px] text-smoke">{t.showcaseHint}</p>
      </div>
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
            <ConnectorTile key={connector.id} connector={connector} blurb={blurbs[connector.id]} connected={isConnected(connector)} query={catalog.searching ? query : undefined} />
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
                <ConnectorTile key={connector.id} connector={connector} blurb={blurbs[connector.id]} connected={isConnected(connector)} query={catalog.searching ? query : undefined} />
              ))}
            </ul>
          )}
        </div>
      )}
      <ManualCta />
    </div>
  );
}
