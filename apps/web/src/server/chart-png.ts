import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Resvg } from "@resvg/resvg-wasm";
import { chartScene, normalizeChart, sceneSvg, type Chart } from "@/lib/chart";
import { env } from "@/lib/env";
import { initResvg } from "./figure-png";

export const CHART_PREFIX = "/api/charts/";
const ROUTE = /^\/api\/charts\/([A-Za-z0-9_-]{1,4096})\.([A-Za-z0-9_-]{43})\.png$/;
const MAX_PAYLOAD = 4096;
const MAX_URL = 3000;
const CACHE_SIZE = 64;
const FONTS = ["400Regular/Inter_400Regular.ttf", "600SemiBold/Inter_600SemiBold.ttf"];
const cache = new Map<string, Buffer>();
let fonts: Promise<Uint8Array[]> | null = null;

function key() {
  const secret = process.env.UNDERSTUDY_SECRET_KEY?.trim() || process.env.BETTER_AUTH_SECRET?.trim();
  if (!secret) throw new Error("UNDERSTUDY_SECRET_KEY or BETTER_AUTH_SECRET must be set");
  return createHash("sha256").update(`${secret}:understudy-chart-image`).digest();
}

function sign(payload: string) {
  return createHmac("sha256", key()).update(payload).digest("base64url");
}

export function chartToken(chart: Chart) {
  const payload = Buffer.from(JSON.stringify(chart)).toString("base64url");
  return payload.length > MAX_PAYLOAD ? null : `${payload}.${sign(payload)}`;
}

export function readChartToken(payload: string, signature: string): Chart | null {
  if (payload.length > MAX_PAYLOAD) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    return normalizeChart(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

function publicBase() {
  if (!process.env.UNDERSTUDY_PUBLIC_URL?.trim()) return null;
  try {
    const url = new URL(env.publicUrl);
    if (!["http:", "https:"].includes(url.protocol) || /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(url.host)) return null;
    return env.publicUrl;
  } catch {
    return null;
  }
}

function safeToken(chart: Chart) {
  try {
    return chartToken(chart);
  } catch {
    return null;
  }
}

export function chartImageUrl(chart: Chart) {
  const base = publicBase();
  const token = base && safeToken(chart);
  if (!base || !token) return null;
  const url = `${base}${CHART_PREFIX}${token}.png`;
  return url.length > MAX_URL ? null : url;
}

function fontPath(file: string) {
  const bundled = join(dirname(process.argv[1] ?? "."), "fonts", file.split("/").pop() as string);
  if (existsSync(bundled)) return bundled;
  return createRequire(import.meta.url).resolve(`@expo-google-fonts/inter/${file}`);
}

function loadFonts() {
  fonts ??= Promise.all(FONTS.map((file) => readFile(fontPath(file)).then((bytes) => new Uint8Array(bytes))));
  return fonts;
}

export async function chartPng(chart: Chart) {
  const id = JSON.stringify(chart);
  const hit = cache.get(id);
  if (hit) {
    cache.delete(id);
    cache.set(id, hit);
    return hit;
  }
  const [, fontBuffers] = await Promise.all([initResvg(), loadFonts()]);
  const svg = sceneSvg(chartScene(chart), "light");
  const png = Buffer.from(new Resvg(svg, { fitTo: { mode: "width", value: 1280 }, font: { fontBuffers, defaultFontFamily: "Inter", sansSerifFamily: "Inter" } }).render().asPng());
  if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  cache.set(id, png);
  return png;
}

export function isChartRoute(pathname: string) {
  return pathname.startsWith(CHART_PREFIX);
}

export async function handleChartRoute(req: IncomingMessage, res: ServerResponse, pathname: string) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    res.end();
    return;
  }
  const match = ROUTE.exec(pathname);
  const chart = match && readChartToken(match[1], match[2]);
  if (!chart) {
    res.writeHead(404);
    res.end();
    return;
  }
  const png = await chartPng(chart);
  res.writeHead(200, {
    "Content-Type": "image/png",
    "Content-Length": png.length,
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(req.method === "HEAD" ? undefined : png);
}
