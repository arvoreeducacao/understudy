import { Code2, FileText, Image as ImageIcon, LoaderCircle, Presentation, Search } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { ArtifactKind } from "@understudy/protocol";
import { agentArtifacts, artifactView } from "@/app/actions/artifacts";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/controls";
import type { Look } from "@/lib/look";
import { currentLocale, messages } from "@/lib/messages";
import type { ArtifactSummary, ArtifactView } from "@/server/artifacts/service";
import type { ViewerToServer } from "@/server/hub-types";
import { ARTIFACT_EVENT, artifactSearch, formatLabel, matchesQuery, readArtifactAddress, shelvesOf, splitTitle, type ArtifactAddress } from "./artifact-ui";
import { ArtifactViewer } from "./ArtifactViewer";

const t = messages.artifacts;

const KIND_ICON: Record<ArtifactKind, typeof FileText> = { html: Code2, markdown: FileText, pages: Presentation, image: ImageIcon };

const FILTERS: (ArtifactKind | "all")[] = ["all", "pages", "markdown", "html", "image"];

const SHELF_PREVIEW = 4;

const SEARCH_FROM = 5;

export function KindIcon({ kind, size = 16 }: { kind: ArtifactKind; size?: number }) {
  const Icon = KIND_ICON[kind] ?? FileText;
  return <Icon size={size} aria-hidden />;
}

function dayOf(iso: string) {
  return new Date(iso).toLocaleString(currentLocale(), { dateStyle: "medium", timeStyle: "short" });
}

export function openArtifact(address: ArtifactAddress) {
  const next = `${window.location.pathname}${artifactSearch(window.location.search, address)}`;
  window.history.pushState(null, "", next);
}

function ArtifactTile({ item, label, onOpen }: { item: ArtifactSummary; label?: string; onOpen: () => void }) {
  return (
    <button type="button" className="art-tile" onClick={onOpen} aria-label={t.open(item.title)}>
      <span className="art-tile-preview">
        <span className="art-kind">
          <KindIcon kind={item.kind} size={12} />
          {formatLabel(item.kind, item.name)}
        </span>
        {item.thumbUrl ? <img src={item.thumbUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <KindIcon kind={item.kind} size={34} />}
      </span>
      <span className="art-tile-meta">
        <span className="min-w-0 flex-1">
          <span className="art-tile-title" title={item.title}>
            {label ?? item.title}
          </span>
          <span className="art-tile-line" suppressHydrationWarning>
            {dayOf(item.updatedAt)}
          </span>
        </span>
        <span className={`art-pill ${item.latestVersion > 1 ? "is-new" : ""}`}>v{item.latestVersion}</span>
      </span>
    </button>
  );
}

export function useArtifactList(agentId: string) {
  const [items, setItems] = useState<ArtifactSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => {
    agentArtifacts(agentId)
      .then((next) => {
        setItems(next);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, [agentId]);
  useEffect(() => {
    load();
    window.addEventListener(ARTIFACT_EVENT, load);
    return () => window.removeEventListener(ARTIFACT_EVENT, load);
  }, [load]);
  return { items, failed };
}

function useArtifactView(agentId: string, address: ArtifactAddress | null) {
  const [state, setState] = useState<{ key: string; view: ArtifactView | null; failed?: boolean } | null>(null);
  const key = address ? `${address.artifactId}:${address.version ?? "latest"}` : "";
  const [bump, setBump] = useState(0);
  useEffect(() => {
    if (!address) return;
    const onEvent = () => setBump((b) => b + 1);
    window.addEventListener(ARTIFACT_EVENT, onEvent);
    return () => window.removeEventListener(ARTIFACT_EVENT, onEvent);
  }, [address]);
  useEffect(() => {
    if (!address) return;
    let alive = true;
    artifactView(agentId, address.artifactId, address.version ?? undefined)
      .then((view) => alive && setState({ key, view }))
      .catch(() => alive && setState({ key, view: null, failed: true }));
    return () => {
      alive = false;
    };
  }, [agentId, address?.artifactId, address?.version, key, bump]);
  return state && state.key === key ? state : null;
}

export function ArtifactsPanel({
  agentId,
  agentName,
  look,
  owner,
  send,
}: {
  agentId: string;
  agentName: string;
  look: Look;
  owner: boolean;
  send?: (message: ViewerToServer) => boolean;
}) {
  const pathname = usePathname();
  const params = useSearchParams();
  const address = readArtifactAddress(new URLSearchParams(params.toString()));
  const { items, failed } = useArtifactList(agentId);
  const opened = useArtifactView(agentId, address);
  const [filter, setFilter] = useState<ArtifactKind | "all">("all");
  const [shelfKey, setShelfKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const go = (next: ArtifactAddress | null) => window.history.pushState(null, "", `${pathname}${artifactSearch(params.toString(), next)}`);

  if (address) {
    if (!opened) {
      return (
        <div className="art-loading" role="status">
          <LoaderCircle size={16} className="cx-spin" aria-hidden /> {t.loading}
        </div>
      );
    }
    if (!opened.view) {
      return (
        <div className="art-loading" role="status">
          <span>{opened.failed ? t.loadFailed : t.gone}</span>
          <button type="button" className="art-link-btn" onClick={() => go(null)}>
            {t.back}
          </button>
        </div>
      );
    }
    return (
      <ArtifactViewer
        view={opened.view}
        agentName={agentName}
        mode="panel"
        owner={owner}
        send={owner ? send : undefined}
        onBack={() => go(null)}
        onSelectVersion={(version) => go({ artifactId: opened.view!.id, version: version === opened.view!.latestVersion ? null : version })}
      />
    );
  }

  if (failed && !items) return <div className="art-loading">{t.loadFailed}</div>;
  if (!items) {
    return (
      <div className="art-loading" role="status">
        <LoaderCircle size={16} className="cx-spin" aria-hidden /> {t.loading}
      </div>
    );
  }
  if (items.length === 0) return <EmptyState look={look} mood="happy" title={t.empty} body={t.emptyBody(agentName)} />;

  const kinds = new Set(items.map((item) => item.kind));
  const ofKind = filter === "all" ? items : items.filter((item) => item.kind === filter);
  const searching = query.trim().length > 0;
  const found = searching ? ofKind.filter((item) => matchesQuery(item.title, query)) : ofKind;
  const { shelves, loose } = shelvesOf(ofKind);
  const allShelves = shelvesOf(items).shelves;
  const openShelf = shelfKey ? shelves.find((shelf) => shelf.key === shelfKey) : undefined;
  const tile = (item: ArtifactSummary, label?: string) => <ArtifactTile key={item.id} item={item} label={label} onOpen={() => go({ artifactId: item.id, version: null })} />;
  const shortTitle = (item: ArtifactSummary) => splitTitle(item.title).rest;

  let body;
  if (searching) {
    body = found.length === 0 ? <p className="art-none">{t.noMatch(query.trim())}</p> : <div className="art-grid">{found.map((item) => tile(item))}</div>;
  } else if (openShelf) {
    body = <div className="art-grid">{openShelf.items.map((item) => tile(item, shortTitle(item)))}</div>;
  } else if (shelves.length > 0) {
    body = (
      <>
        {shelves.map((shelf) => (
          <section key={shelf.key} className="art-shelf" aria-label={shelf.name}>
            <div className="art-shelf-head">
              <h3>{shelf.name}</h3>
              <span>{t.shelfCount(shelf.items.length)}</span>
              {shelf.items.length > SHELF_PREVIEW && (
                <button type="button" className="art-link-btn" onClick={() => setShelfKey(shelf.key)}>
                  {t.seeAll}
                </button>
              )}
            </div>
            <div className="art-grid">{shelf.items.slice(0, SHELF_PREVIEW).map((item) => tile(item, shortTitle(item)))}</div>
          </section>
        ))}
        {loose.length > 0 && (
          <section className="art-shelf" aria-label={t.others}>
            <div className="art-shelf-head">
              <h3>{t.others}</h3>
              <span>{t.shelfCount(loose.length)}</span>
            </div>
            <div className="art-grid">{loose.map((item) => tile(item))}</div>
          </section>
        )}
      </>
    );
  } else {
    body = ofKind.length === 0 ? <p className="art-none">{t.nothingOfKind}</p> : <div className="art-grid">{ofKind.map((item) => tile(item))}</div>;
  }

  return (
    <div className="art-list">
      <p className="art-lead">{t.lead(agentName)}</p>
      {items.length >= SEARCH_FROM && (
        <div className="conn-search art-search">
          <Search size={15} aria-hidden />
          <Input type="search" value={query} placeholder={t.searchPlaceholder} aria-label={t.searchLabel} autoComplete="off" maxLength={80} onChange={(e) => setQuery(e.target.value)} />
        </div>
      )}
      {allShelves.length > 0 && !searching && (
        <div className="art-filters" role="group" aria-label={t.shelvesLabel}>
          <button type="button" className={`art-filter ${!openShelf ? "is-on" : ""}`} aria-pressed={!openShelf} onClick={() => setShelfKey(null)}>
            {t.allShelves}
          </button>
          {allShelves.map((shelf) => (
            <button key={shelf.key} type="button" className={`art-filter ${openShelf?.key === shelf.key ? "is-on" : ""}`} aria-pressed={openShelf?.key === shelf.key} onClick={() => setShelfKey(shelf.key)}>
              {shelf.name} <span className="art-filter-count">{shelf.items.length}</span>
            </button>
          ))}
        </div>
      )}
      {kinds.size > 1 && (
        <div className="art-filters" role="group" aria-label={t.kindsLabel}>
          {FILTERS.filter((f) => f === "all" || kinds.has(f)).map((f) => (
            <button key={f} type="button" className={`art-filter ${filter === f ? "is-on" : ""}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f === "all" ? t.all : t.kinds[f]}
            </button>
          ))}
        </div>
      )}
      {body}
    </div>
  );
}
