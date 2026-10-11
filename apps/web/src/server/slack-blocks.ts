import { chartSummary, parseChart, type Chart } from "@/lib/chart";
import { columnAlign, inlineText, parseMarkdownSources, type Block, type Inline, type SourcedBlock } from "@/lib/markdown";

export const SLACK_LIMITS = {
  blocks: 50,
  markdown: 12_000,
  header: 150,
  section: 3_000,
  fields: 10,
  field: 2_000,
  context: 3_000,
  buttons: 5,
  button: 75,
  url: 3_000,
  tableRows: 100,
  tableColumns: 20,
  tableChars: 10_000,
  json: 60_000,
};

const FALLBACK_LIMIT = 3_900;
const VALUE_MAX = 200;
const PLAIN_VALUE_MAX = 60;
const CONTEXT_MAX = 300;
const CONTEXT_START = /^(sources?|updated|last updated|as of|data as of)\b/i;

export type SlackBlock = Record<string, unknown>;
export type RichMessage = { blocks: SlackBlock[]; text: string };
export type RichOptions = { chartUrl?: (chart: Chart) => string | null };

export function plainFallback(text: string) {
  return text
    .replace(/```[a-z]*\n?/g, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .slice(0, FALLBACK_LIMIT);
}

function escapeMrkdwn(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function mark(marker: string, inner: string) {
  const text = inner.trim();
  return text ? `${marker}${text}${marker}` : "";
}

export function toMrkdwn(nodes: Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case "text":
          return escapeMrkdwn(node.value);
        case "code":
          return node.value ? `\`${escapeMrkdwn(node.value.replace(/`/g, "'"))}\`` : "";
        case "strong":
          return mark("*", toMrkdwn(node.children));
        case "em":
          return mark("_", toMrkdwn(node.children));
        case "strike":
          return mark("~", toMrkdwn(node.children));
        case "link":
          return `<${node.href.replace(/\|/g, "%7C")}|${toMrkdwn(node.children).replace(/\|/g, "/") || escapeMrkdwn(node.href)}>`;
        case "break":
          return "\n";
      }
    })
    .join("");
}

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function plain(nodes: Inline[]) {
  return inlineText(nodes).replace(/\s+/g, " ").trim();
}

function splitLines(nodes: Inline[]): Inline[][] {
  const lines: Inline[][] = [[]];
  for (const node of nodes) {
    if (node.kind === "break") lines.push([]);
    else lines[lines.length - 1].push(node);
  }
  return lines;
}

function trimLeading(nodes: Inline[]): Inline[] {
  const [first, ...rest] = nodes;
  if (first?.kind !== "text") return nodes;
  const value = first.value.replace(/^\s+/, "");
  return value ? [{ kind: "text", value }, ...rest] : rest;
}

type KeyValue = { label: string; value: Inline[]; bold: boolean };

export function keyValue(nodes: Inline[]): KeyValue | null {
  const [first, ...rest] = nodes;
  if (!first) return null;
  let found: KeyValue | null = null;
  if (first.kind === "strong") {
    const label = plain(first.children);
    const next = rest[0];
    if (label.endsWith(":") && label.length > 1) found = { label: label.slice(0, -1).trim(), value: trimLeading(rest), bold: true };
    else if (next?.kind === "text" && next.value.startsWith(":")) found = { label, value: trimLeading([{ kind: "text", value: next.value.slice(1) }, ...rest.slice(1)]), bold: true };
  } else if (first.kind === "text") {
    const match = /^([\p{L}\p{N}][^:\n]{0,39}?):\s+(.*)$/su.exec(first.value);
    if (match && match[1].trim().split(/\s+/).length <= 3 && !/https?$/i.test(match[1])) {
      found = { label: match[1].trim(), value: trimLeading([...(match[2] ? [{ kind: "text" as const, value: match[2] }] : []), ...rest]), bold: false };
    }
  }
  if (!found || !found.label || found.label.length > 60) return null;
  const value = plain(found.value);
  if (!value || value.length > (found.bold ? VALUE_MAX : PLAIN_VALUE_MAX)) return null;
  return found;
}

function linkOnly(block: Block): { label: string; url: string }[] | null {
  const nodes = block.kind === "paragraph" ? block.children : block.kind === "list" && block.items.every((item) => item.depth === 0) ? block.items.flatMap((item) => [...item.children, { kind: "break" as const }]) : null;
  if (!nodes) return null;
  const links: { label: string; url: string }[] = [];
  for (const node of nodes) {
    if (node.kind === "break" || (node.kind === "text" && /^[\s·|•,–-]*$/.test(node.value))) continue;
    if (node.kind !== "link" || !/^https?:/.test(node.href)) return null;
    const label = plain(node.children);
    if (!label || label === node.href || node.href.length > SLACK_LIMITS.url) return null;
    links.push({ label: clip(label, SLACK_LIMITS.button), url: node.href });
  }
  return links.length >= 1 && links.length <= SLACK_LIMITS.buttons ? links : null;
}

function contextNote(block: Block): string | null {
  if (block.kind !== "paragraph") return null;
  const text = plain(block.children);
  if (!text || text.length > CONTEXT_MAX) return null;
  const solid = block.children.filter((node) => !(node.kind === "text" && !node.value.trim()));
  if (solid.length === 1 && solid[0].kind === "em") return toMrkdwn(solid[0].children).trim();
  return CONTEXT_START.test(text) ? toMrkdwn(block.children).trim() : null;
}

function header(nodes: Inline[]): SlackBlock | null {
  const text = clip(plain(nodes), SLACK_LIMITS.header);
  return text ? { type: "header", text: { type: "plain_text", text, emoji: true } } : null;
}

function subheading(nodes: Inline[]): SlackBlock | null {
  const text = mark("*", toMrkdwn(nodes).replace(/\*/g, ""));
  return text ? { type: "section", text: { type: "mrkdwn", text: clip(text, SLACK_LIMITS.section) } } : null;
}

function fallbackText(entries: SourcedBlock[]) {
  return plainFallback(
    entries
      .map(({ block, source }) => {
        const chart = block.kind === "code" && block.lang === "chart" && !block.open ? parseChart(block.value) : null;
        return chart ? chartSummary(chart) : source;
      })
      .join("\n\n"),
  );
}

function fieldsSections(pairs: KeyValue[]): SlackBlock[] {
  const fields = pairs.map((pair) => ({ type: "mrkdwn", text: clip(`*${escapeMrkdwn(pair.label)}*\n${toMrkdwn(pair.value).trim()}`, SLACK_LIMITS.field) }));
  const sections: SlackBlock[] = [];
  for (let i = 0; i < fields.length; i += SLACK_LIMITS.fields) sections.push({ type: "section", fields: fields.slice(i, i + SLACK_LIMITS.fields) });
  return sections;
}

type RichText = { type: "text"; text: string; style?: Record<string, boolean> } | { type: "link"; url: string; text?: string; style?: Record<string, boolean> };

function richElements(nodes: Inline[], style: Record<string, boolean> = {}): RichText[] {
  const styled = Object.keys(style).length ? { style } : {};
  return nodes.flatMap((node): RichText[] => {
    switch (node.kind) {
      case "text":
        return node.value ? [{ type: "text", text: node.value, ...styled }] : [];
      case "code":
        return node.value ? [{ type: "text", text: node.value, style: { ...style, code: true } }] : [];
      case "strong":
        return richElements(node.children, { ...style, bold: true });
      case "em":
        return richElements(node.children, { ...style, italic: true });
      case "strike":
        return richElements(node.children, { ...style, strike: true });
      case "link":
        return [{ type: "link", url: node.href, text: inlineText(node.children) || node.href, ...styled }];
      case "break":
        return [{ type: "text", text: "\n" }];
    }
  });
}

function tableCell(nodes: Inline[]) {
  const text = inlineText(nodes).trim();
  if (!text) return { type: "raw_text", text: "–" };
  if (nodes.every((node) => node.kind === "text")) return { type: "raw_text", text };
  return { type: "rich_text", elements: [{ type: "rich_text_section", elements: richElements(nodes) }] };
}

function tableBlock(table: Extract<Block, { kind: "table" }>): SlackBlock | null {
  const rows = [table.header, ...table.rows];
  if (rows.length > SLACK_LIMITS.tableRows || table.header.length > SLACK_LIMITS.tableColumns) return null;
  const chars = rows.reduce((sum, row) => sum + row.reduce((cells, cell) => cells + inlineText(cell).length, 0), 0);
  if (chars > SLACK_LIMITS.tableChars) return null;
  const column_settings = table.header.map((_, column) => {
    const align = columnAlign(table, column);
    return align === "left" ? { align, is_wrapped: true } : { align };
  });
  return { type: "table", column_settings, rows: rows.map((row) => row.map(tableCell)) };
}

function chartFallback(chart: Chart) {
  const [title, ...lines] = chartSummary(chart).split("\n");
  return chart.title ? [`**${title}**`, ...lines].join("\n") : [title, ...lines].join("\n");
}

function sourceLines(entry: SourcedBlock) {
  return entry.source.split("\n");
}

function lineGroups(entry: SourcedBlock): { lines: Inline[][]; source: string[] } | null {
  const { block } = entry;
  const source = sourceLines(entry);
  if (block.kind === "paragraph") {
    const lines = splitLines(block.children);
    return lines.length === source.length ? { lines, source } : null;
  }
  if (block.kind === "list" && block.items.every((item) => item.depth === 0) && block.items.length === source.length && block.items.every((item) => !item.children.some((node) => node.kind === "break"))) {
    return { lines: block.items.map((item) => item.children), source };
  }
  return null;
}

function trailing(entries: SourcedBlock[]) {
  const body = [...entries];
  let actions: SlackBlock | null = null;
  let context: SlackBlock | null = null;
  for (let round = 0; round < 2 && body.length > 1; round += 1) {
    const last = body[body.length - 1].block;
    const links: { label: string; url: string }[] | null = actions ? null : linkOnly(last);
    if (links) {
      actions = { type: "actions", elements: links.map((link, i) => ({ type: "button", action_id: `link_${i}`, text: { type: "plain_text", text: link.label, emoji: true }, url: link.url })) };
      body.pop();
      continue;
    }
    const note: string | null = context ? null : contextNote(last);
    if (note) {
      context = { type: "context", elements: [{ type: "mrkdwn", text: clip(note, SLACK_LIMITS.context) }] };
      body.pop();
      continue;
    }
    break;
  }
  return { body, tail: [context, actions].filter((block): block is SlackBlock => Boolean(block)) };
}

export function validSlackMessage(blocks: SlackBlock[]) {
  if (blocks.length === 0 || blocks.length > SLACK_LIMITS.blocks) return false;
  let markdown = 0;
  let tables = 0;
  for (const block of blocks) {
    const text = (block.text as { text?: string } | string | undefined) ?? "";
    switch (block.type) {
      case "markdown":
        markdown += String(text).length;
        if (!String(text).trim()) return false;
        break;
      case "header":
        if (typeof text !== "object" || !text.text || text.text.length > SLACK_LIMITS.header) return false;
        break;
      case "section": {
        const fields = (block.fields as { text: string }[] | undefined) ?? [];
        if (typeof text === "object" && (text.text ?? "").length > SLACK_LIMITS.section) return false;
        if (fields.length > SLACK_LIMITS.fields || fields.some((field) => !field.text || field.text.length > SLACK_LIMITS.field)) return false;
        break;
      }
      case "context":
        if ((block.elements as { text: string }[]).some((element) => !element.text || element.text.length > SLACK_LIMITS.context)) return false;
        break;
      case "actions":
        if ((block.elements as { text: { text: string }; url: string }[]).some((button) => !button.text.text || button.text.text.length > SLACK_LIMITS.button || button.url.length > SLACK_LIMITS.url)) return false;
        break;
      case "image":
        if (String(block.image_url).length > SLACK_LIMITS.url) return false;
        break;
      case "table":
        tables += 1;
        break;
    }
  }
  return markdown <= SLACK_LIMITS.markdown && tables <= 1 && JSON.stringify(blocks).length <= SLACK_LIMITS.json;
}

export function richSlackMessage(markdown: string, options: RichOptions = {}): RichMessage | null {
  const entries = parseMarkdownSources(markdown);
  const { body, tail } = trailing(entries);
  const blocks: SlackBlock[] = [];
  let run: string[] = [];
  let structured = false;
  let tableUsed = false;
  const flush = () => {
    if (run.length) blocks.push({ type: "markdown", text: run.join("\n\n") });
    run = [];
  };
  const emit = (...items: SlackBlock[]) => {
    flush();
    blocks.push(...items);
  };

  for (const entry of body) {
    const { block } = entry;
    if (block.kind === "heading") {
      const title = block.level <= 2 ? header(block.children) : subheading(block.children);
      if (title) emit(title);
      continue;
    }
    if (block.kind === "rule") {
      emit({ type: "divider" });
      continue;
    }
    if (block.kind === "table" && !tableUsed) {
      const table = tableBlock(block);
      if (table) {
        tableUsed = true;
        structured = true;
        emit(table);
        continue;
      }
    }
    if (block.kind === "code" && block.lang === "chart" && !block.open) {
      const chart = parseChart(block.value);
      if (chart) {
        structured = true;
        const url = options.chartUrl?.(chart);
        if (url) {
          const alt = clip(chart.title ?? "Chart", 2000);
          emit({ type: "image", image_url: url, alt_text: alt, ...(chart.title ? { title: { type: "plain_text", text: alt } } : {}) });
        } else run.push(chartFallback(chart));
        continue;
      }
    }
    const groups = lineGroups(entry);
    if (groups) {
      const pairs = groups.lines.map(keyValue);
      let i = 0;
      while (i < pairs.length) {
        let end = i;
        while (end < pairs.length && pairs[end]) end += 1;
        if (end - i >= 2) {
          structured = true;
          emit(...fieldsSections(pairs.slice(i, end) as KeyValue[]));
          i = end;
          continue;
        }
        const start = i;
        i = Math.max(end, i + 1);
        while (i < pairs.length && !(pairs[i] && pairs[i + 1])) i += 1;
        run.push(groups.source.slice(start, i).join("\n"));
      }
      continue;
    }
    run.push(entry.source);
  }
  flush();

  if (!structured) return null;
  const all = [...blocks, ...tail];
  if (!validSlackMessage(all)) return null;
  return { blocks: all, text: fallbackText(entries) };
}
