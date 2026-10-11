export type Chart = { type: "bar" | "line"; title?: string; labels: string[]; series: { name: string; values: number[] }[]; unit?: string };

export type ChartTone = "series0" | "series1" | "series2" | "series3" | "text" | "muted" | "grid" | "axis" | "surface";

export type ChartItem =
  | { kind: "rect"; x: number; y: number; width: number; height: number; tone: ChartTone }
  | { kind: "path"; d: string; tone: ChartTone; fill: boolean; title?: string }
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number; tone: ChartTone }
  | { kind: "circle"; cx: number; cy: number; r: number; tone: ChartTone; title?: string }
  | { kind: "text"; x: number; y: number; text: string; tone: ChartTone; size: number; anchor: "start" | "middle" | "end"; weight?: number };

export type ChartScene = { width: number; height: number; items: ChartItem[]; label: string };

export const CHART_LIMITS = { labels: 24, series: 4, label: 40, title: 80, unit: 12 };

export const CHART_COLORS: Record<"light" | "dark", Record<ChartTone, string>> = {
  light: { series0: "#2a78d6", series1: "#eb6834", series2: "#1baf7a", series3: "#eda100", text: "#1f1f1f", muted: "#52514e", grid: "#e4e3df", axis: "#a3a29c", surface: "#ffffff" },
  dark: { series0: "#3987e5", series1: "#d95926", series2: "#199e70", series3: "#c98500", text: "#e9eaee", muted: "#9c9c9d", grid: "#2a2c33", axis: "#5c5e66", surface: "#0a0b10" },
};

const WIDTH = 640;
const HEIGHT = 360;
export const COMPACT_CHART = { width: 440, height: 280 };
const FONT = "Inter, system-ui, sans-serif";

function cleanText(value: unknown, max: number) {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function normalizeChart(input: unknown): Chart | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  if (raw.type !== "bar" && raw.type !== "line") return null;
  if (!Array.isArray(raw.labels) || !Array.isArray(raw.series) || raw.labels.length === 0 || raw.series.length === 0) return null;
  const labels = raw.labels.slice(0, CHART_LIMITS.labels).map((label) => (typeof label === "number" && Number.isFinite(label) ? String(label) : cleanText(label, CHART_LIMITS.label)));
  if (labels.some((label) => label === null)) return null;
  if (raw.type === "line" && labels.length < 2) return null;
  const series: Chart["series"] = [];
  for (const entry of raw.series.slice(0, CHART_LIMITS.series)) {
    if (!entry || typeof entry !== "object") return null;
    const { name, values } = entry as Record<string, unknown>;
    const cleanName = cleanText(name, CHART_LIMITS.label);
    if (!cleanName || !Array.isArray(values) || values.length < labels.length) return null;
    const numbers = values.slice(0, labels.length);
    if (!numbers.every((value) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) < 1e15)) return null;
    series.push({ name: cleanName, values: numbers as number[] });
  }
  const title = raw.title === undefined ? null : cleanText(raw.title, CHART_LIMITS.title);
  const unit = raw.unit === undefined ? null : cleanText(raw.unit, CHART_LIMITS.unit);
  return { type: raw.type, ...(title ? { title } : {}), labels: labels as string[], series, ...(unit ? { unit } : {}) };
}

export function parseChart(source: string): Chart | null {
  if (source.length > 20_000) return null;
  try {
    return normalizeChart(JSON.parse(source));
  } catch {
    return null;
  }
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function trimNumber(value: number, digits: number) {
  return value.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

export function formatValue(value: number, unit?: string) {
  const abs = Math.abs(value);
  const scaled = abs >= 1e9 ? `${trimNumber(value / 1e9, 1)}B` : abs >= 1e6 ? `${trimNumber(value / 1e6, 1)}M` : abs >= 1e4 ? `${trimNumber(value / 1e3, 1)}k` : trimNumber(value, abs >= 100 ? 0 : 2);
  if (!unit) return scaled;
  return unit === "%" ? `${scaled}%` : `${scaled} ${unit}`;
}

export function niceScale(min: number, max: number, count = 4) {
  const low = Math.min(0, min);
  const high = Math.max(0, max);
  if (low === high) return { min: 0, max: 1, step: 0.25 };
  const raw = (high - low) / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((candidate) => candidate >= raw) ?? 10 * magnitude;
  return { min: Math.floor(low / step) * step, max: Math.ceil(high / step) * step, step };
}

function textWidth(text: string, size: number) {
  return text.length * size * 0.56;
}

function shorten(text: string, max: number) {
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

function barPath(x: number, from: number, to: number, width: number) {
  const height = Math.abs(to - from);
  const r = Math.min(4, width / 2, height);
  const up = to < from;
  const top = up ? to : from;
  const bottom = up ? from : to;
  if (up) return `M${round(x)} ${round(bottom)}V${round(top + r)}Q${round(x)} ${round(top)} ${round(x + r)} ${round(top)}H${round(x + width - r)}Q${round(x + width)} ${round(top)} ${round(x + width)} ${round(top + r)}V${round(bottom)}Z`;
  return `M${round(x)} ${round(top)}V${round(bottom - r)}Q${round(x)} ${round(bottom)} ${round(x + r)} ${round(bottom)}H${round(x + width - r)}Q${round(x + width)} ${round(bottom)} ${round(x + width)} ${round(bottom - r)}V${round(top)}Z`;
}

export function chartSummary(chart: Chart) {
  const lines = chart.series.map((series) => `${chart.series.length > 1 ? `${series.name}: ` : ""}${chart.labels.map((label, i) => `${label} ${formatValue(series.values[i], chart.unit)}`).join(", ")}`);
  return [chart.title, ...lines].filter(Boolean).join("\n");
}

export function chartScene(chart: Chart, size: { width: number; height: number } = { width: WIDTH, height: HEIGHT }): ChartScene {
  const items: ChartItem[] = [{ kind: "rect", x: 0, y: 0, width: size.width, height: size.height, tone: "surface" }];
  let top = 16;
  if (chart.title) {
    items.push({ kind: "text", x: 20, y: top + 14, text: chart.title, tone: "text", size: 16, anchor: "start", weight: 600 });
    top += 28;
  }
  if (chart.series.length > 1) {
    let x = 20;
    chart.series.forEach((series, i) => {
      const tone = `series${i}` as ChartTone;
      items.push({ kind: "rect", x, y: top + 3, width: 10, height: 10, tone });
      items.push({ kind: "text", x: x + 15, y: top + 12, text: series.name, tone: "muted", size: 12, anchor: "start" });
      x += 15 + textWidth(series.name, 12) + 18;
    });
    top += 24;
  }
  top += 8;
  const values = chart.series.flatMap((series) => series.values);
  const scale = niceScale(Math.min(...values), Math.max(...values));
  const ticks: number[] = [];
  for (let value = scale.min; value <= scale.max + scale.step / 2; value += scale.step) ticks.push(Math.round(value / scale.step) * scale.step);
  const tickLabels = ticks.map((tick) => formatValue(tick, chart.unit));
  const left = 20 + Math.max(...tickLabels.map((label) => textWidth(label, 11))) + 10;
  const right = size.width - 20;
  const bottom = size.height - 34;
  const plotWidth = right - left;
  const y = (value: number) => bottom - ((value - scale.min) / (scale.max - scale.min)) * (bottom - top);
  ticks.forEach((tick, i) => {
    items.push({ kind: "line", x1: left, y1: round(y(tick)), x2: right, y2: round(y(tick)), tone: tick === 0 ? "axis" : "grid" });
    items.push({ kind: "text", x: left - 8, y: round(y(tick) + 4), text: tickLabels[i], tone: "muted", size: 11, anchor: "end" });
  });
  const count = chart.labels.length;
  const slot = plotWidth / count;
  const longest = Math.max(...chart.labels.map((label) => label.length));
  const fit = Math.max(3, Math.floor(slot / 6.4));
  const every = Math.max(1, Math.ceil((Math.min(longest, 14) * 6.4 + 8) / slot));
  const center = (i: number) => (chart.type === "bar" ? left + slot * i + slot / 2 : left + 8 + (count === 1 ? (plotWidth - 16) / 2 : ((plotWidth - 16) / (count - 1)) * i));
  chart.labels.forEach((label, i) => {
    if (i % every !== 0) return;
    items.push({ kind: "text", x: round(center(i)), y: bottom + 18, text: shorten(label, every > 1 ? 14 : Math.min(14, fit)), tone: "muted", size: 11, anchor: chart.type === "line" && i === 0 ? "start" : chart.type === "line" && i === count - 1 ? "end" : "middle" });
  });
  const zero = y(Math.max(scale.min, Math.min(0, scale.max)));
  if (chart.type === "bar") {
    const group = slot * 0.72;
    const width = (group - (chart.series.length - 1) * 2) / chart.series.length;
    chart.series.forEach((series, s) => {
      series.values.forEach((value, i) => {
        if (value === 0) return;
        const x = left + slot * i + (slot - group) / 2 + s * (width + 2);
        items.push({ kind: "path", d: barPath(x, zero, y(value), width), tone: `series${s}` as ChartTone, fill: true, title: `${chart.labels[i]} · ${series.name}: ${formatValue(value, chart.unit)}` });
      });
    });
  } else {
    chart.series.forEach((series, s) => {
      const tone = `series${s}` as ChartTone;
      const d = series.values.map((value, i) => `${i === 0 ? "M" : "L"}${round(center(i))} ${round(y(value))}`).join("");
      items.push({ kind: "path", d, tone, fill: false });
      if (count <= 24) series.values.forEach((value, i) => items.push({ kind: "circle", cx: round(center(i)), cy: round(y(value)), r: 3.5, tone, title: `${chart.labels[i]} · ${series.name}: ${formatValue(value, chart.unit)}` }));
    });
  }
  return { width: size.width, height: size.height, items, label: chartSummary(chart) };
}

function escapeXml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function sceneSvg(scene: ChartScene, theme: "light" | "dark" = "light") {
  const colors = CHART_COLORS[theme];
  const title = (text?: string) => (text ? `<title>${escapeXml(text)}</title>` : "");
  const body = scene.items
    .map((item) => {
      const color = colors[item.tone];
      switch (item.kind) {
        case "rect":
          return `<rect x="${item.x}" y="${item.y}" width="${item.width}" height="${item.height}" fill="${color}"${item.tone === "surface" ? "" : ' rx="2"'}/>`;
        case "line":
          return `<line x1="${item.x1}" y1="${item.y1}" x2="${item.x2}" y2="${item.y2}" stroke="${color}" stroke-width="1"/>`;
        case "path":
          return item.fill
            ? `<path d="${item.d}" fill="${color}">${title(item.title)}</path>`
            : `<path d="${item.d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
        case "circle":
          return `<circle cx="${item.cx}" cy="${item.cy}" r="${item.r}" fill="${color}" stroke="${colors.surface}" stroke-width="2">${title(item.title)}</circle>`;
        case "text":
          return `<text x="${item.x}" y="${item.y}" fill="${color}" font-size="${item.size}" text-anchor="${item.anchor}"${item.weight ? ` font-weight="${item.weight}"` : ""}>${escapeXml(item.text)}</text>`;
      }
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${scene.width} ${scene.height}" width="${scene.width}" height="${scene.height}" font-family="${FONT}" role="img" aria-label="${escapeXml(scene.label)}">${body}</svg>`;
}
