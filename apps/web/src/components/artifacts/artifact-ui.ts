import { extensionOf, type ArtifactKind } from "@understudy/protocol";
import { messages } from "@/lib/messages";

export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const;

export function nextZoom(current: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_STEPS.find((step) => step > current + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  return [...ZOOM_STEPS].reverse().find((step) => step < current - 0.001) ?? ZOOM_STEPS[0];
}

export function formatLabel(kind: ArtifactKind, name: string): string {
  const t = messages.artifacts;
  if (kind === "pages") return t.formats[extensionOf(name)] ?? t.kinds.pages;
  return t.kinds[kind] ?? t.kinds.markdown;
}

export type ArtifactAddress = { artifactId: string; version: number | null };

export function readArtifactAddress(params: URLSearchParams): ArtifactAddress | null {
  const artifactId = params.get("artifact") ?? "";
  if (!/^art_[A-Za-z0-9_-]{6,80}$/.test(artifactId)) return null;
  const raw = params.get("v");
  const version = raw && /^\d{1,6}$/.test(raw) && Number(raw) > 0 ? Number(raw) : null;
  return { artifactId, version };
}

export function artifactSearch(current: string, address: ArtifactAddress | null): string {
  const params = new URLSearchParams(current);
  params.set("tab", "artifacts");
  params.delete("artifact");
  params.delete("v");
  if (address) {
    params.set("artifact", address.artifactId);
    if (address.version) params.set("v", String(address.version));
  }
  return `?${params.toString()}`;
}

export const ARTIFACT_EVENT = "understudy:artifact";

const SHELF_SEPARATOR = /\s+[·—|]\s+/;

export function foldText(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function splitTitle(title: string): { shelf: string | null; rest: string } {
  const match = SHELF_SEPARATOR.exec(title);
  if (!match || match.index === 0) return { shelf: null, rest: title };
  const shelf = title.slice(0, match.index).trim();
  const rest = title.slice(match.index + match[0].length).trim();
  if (!rest || shelf.length > 40) return { shelf: null, rest: title };
  return { shelf, rest };
}

export function matchesQuery(title: string, query: string): boolean {
  const words = foldText(query).split(" ").filter(Boolean);
  if (words.length === 0) return true;
  const haystack = foldText(title);
  return words.every((word) => haystack.includes(word));
}

export type Shelf<T> = { key: string; name: string; items: T[] };

export function shelvesOf<T extends { title: string }>(items: T[]): { shelves: Shelf<T>[]; loose: T[] } {
  const byKey = new Map<string, Shelf<T>>();
  for (const item of items) {
    const { shelf } = splitTitle(item.title);
    if (!shelf) continue;
    const key = foldText(shelf);
    const found = byKey.get(key);
    if (found) found.items.push(item);
    else byKey.set(key, { key, name: shelf, items: [item] });
  }
  const shelves = [...byKey.values()].filter((shelf) => shelf.items.length > 1);
  const shelved = new Set(shelves.flatMap((shelf) => shelf.items));
  return { shelves, loose: items.filter((item) => !shelved.has(item)) };
}
