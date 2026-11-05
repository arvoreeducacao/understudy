export const AGENT_ORDER_LIMIT = 500;

export function applyAgentOrder<T extends { id: string }>(agents: readonly T[], order: readonly string[] | null | undefined): T[] {
  if (!order?.length) return [...agents];
  const position = new Map(order.map((id, index) => [id, index]));
  const unplaced = agents.filter((agent) => !position.has(agent.id));
  const placed = agents.filter((agent) => position.has(agent.id)).sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
  return [...unplaced, ...placed];
}

function unique(ids: readonly unknown[], allowed: ReadonlySet<string>) {
  const seen = new Set<string>();
  for (const id of ids) if (typeof id === "string" && allowed.has(id)) seen.add(id);
  return [...seen];
}

export function mergeAgentOrder(previous: readonly unknown[] | null | undefined, moved: readonly unknown[], allowed: ReadonlySet<string>): string[] {
  const shown = unique(moved, allowed);
  const shownSet = new Set(shown);
  const after = new Map<string | null, string[]>();
  let anchor: string | null = null;
  for (const id of unique(previous ?? [], allowed)) {
    if (shownSet.has(id)) {
      anchor = id;
      continue;
    }
    after.set(anchor, [...(after.get(anchor) ?? []), id]);
  }
  const merged = [...(after.get(null) ?? [])];
  for (const id of shown) merged.push(id, ...(after.get(id) ?? []));
  return merged.slice(0, AGENT_ORDER_LIMIT);
}

export function moveInGroup(order: readonly string[], id: string, target: number, groupOf: (id: string) => string | undefined): string[] {
  const group = groupOf(id);
  const members = order.filter((other) => groupOf(other) === group);
  const others = members.filter((other) => other !== id);
  const index = Math.max(0, Math.min(target, others.length));
  const placed = [...others.slice(0, index), id, ...others.slice(index)];
  let next = 0;
  return order.map((other) => (groupOf(other) === group ? (placed[next++] ?? other) : other));
}

export function sameOrder(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}
