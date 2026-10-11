import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { normalizeChart } from "@/lib/chart";

process.env.BETTER_AUTH_SECRET ??= "test-secret";
const { chartImageUrl, chartPng, chartToken, handleChartRoute, readChartToken } = await import("./chart-png");

const chart = normalizeChart({ type: "bar", title: "Tickets by person", labels: ["Maya", "Ada", "Leo"], series: [{ name: "Tickets", values: [12, 7, 9] }] })!;

function withPublicUrl<T>(value: string | undefined, run: () => T) {
  const before = process.env.UNDERSTUDY_PUBLIC_URL;
  if (value === undefined) delete process.env.UNDERSTUDY_PUBLIC_URL;
  else process.env.UNDERSTUDY_PUBLIC_URL = value;
  try {
    return run();
  } finally {
    if (before === undefined) delete process.env.UNDERSTUDY_PUBLIC_URL;
    else process.env.UNDERSTUDY_PUBLIC_URL = before;
  }
}

test("a signed token reads back the same chart and a tampered one does not", () => {
  const token = chartToken(chart)!;
  const [payload, signature] = token.split(".");
  assert.deepEqual(readChartToken(payload, signature), chart);
  const other = Buffer.from(JSON.stringify({ ...chart, title: "Forged" })).toString("base64url");
  assert.equal(readChartToken(other, signature), null);
  assert.equal(readChartToken(payload, "A".repeat(43)), null);
});

test("image urls use the public url and are skipped when Slack could not fetch them", () => {
  assert.match(withPublicUrl("https://panel.example.com", () => chartImageUrl(chart)) ?? "", /^https:\/\/panel\.example\.com\/api\/charts\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}\.png$/);
  assert.equal(withPublicUrl(undefined, () => chartImageUrl(chart)), null);
  assert.equal(withPublicUrl("http://localhost:3000", () => chartImageUrl(chart)), null);
  const huge = normalizeChart({ type: "line", title: "t".repeat(80), labels: Array.from({ length: 24 }, (_, i) => `${"x".repeat(36)}${i}`), series: [0, 1, 2, 3].map((s) => ({ name: `Series ${s}`.padEnd(40, "s"), values: Array.from({ length: 24 }, (_, i) => i * 1234.5678 + s) })) })!;
  assert.equal(withPublicUrl("https://panel.example.com", () => chartImageUrl(huge)), null);
});

test("the chart renders to a png with its text drawn", async () => {
  const png = await chartPng(chart);
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  const untitled = await chartPng({ ...chart, title: "Tickets by team" });
  assert.notDeepEqual(png, untitled);
});

test("the route serves signed charts with long caching and refuses the rest", async () => {
  const server = createServer((req, res) => void handleChartRoute(req, res, new URL(req.url ?? "/", "http://x").pathname));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const ok = await fetch(`${base}/api/charts/${chartToken(chart)}.png`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "image/png");
    assert.match(ok.headers.get("cache-control") ?? "", /immutable/);
    const [payload] = chartToken(chart)!.split(".");
    assert.equal((await fetch(`${base}/api/charts/${payload}.${"B".repeat(43)}.png`)).status, 404);
    assert.equal((await fetch(`${base}/api/charts/${"A".repeat(5000)}.${"B".repeat(43)}.png`)).status, 404);
    assert.equal((await fetch(`${base}/api/charts/${chartToken(chart)}.png`, { method: "POST" })).status, 405);
  } finally {
    server.close();
  }
});
