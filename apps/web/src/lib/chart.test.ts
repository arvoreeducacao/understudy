import assert from "node:assert/strict";
import { test } from "node:test";
import { chartScene, chartSummary, COMPACT_CHART, formatValue, niceScale, normalizeChart, parseChart, sceneSvg } from "./chart";

const sample = { type: "bar", title: "Deals closed", labels: ["Jan", "Feb", "Mar"], series: [{ name: "Northwind", values: [3, 5, 2] }] };

test("a valid chart is normalized and keeps only known fields", () => {
  assert.deepEqual(parseChart(JSON.stringify({ ...sample, extra: "<script>" })), sample);
});

test("bad input is rejected instead of drawn", () => {
  for (const source of [
    "not json",
    "[]",
    JSON.stringify({ ...sample, type: "pie" }),
    JSON.stringify({ ...sample, labels: [] }),
    JSON.stringify({ ...sample, series: [] }),
    JSON.stringify({ ...sample, series: [{ name: "A", values: [1, 2] }] }),
    JSON.stringify({ ...sample, series: [{ name: "A", values: [1, "2", 3] }] }),
    JSON.stringify({ ...sample, series: [{ name: "", values: [1, 2, 3] }] }),
    JSON.stringify({ ...sample, labels: ["a", {}, "c"] }),
    JSON.stringify({ type: "line", labels: ["only"], series: [{ name: "A", values: [1] }] }),
    '{"type":"bar","labels":["a"],"series":[{"name":"A","values":[1e999]}]}',
  ]) {
    assert.equal(parseChart(source), null, source);
  }
});

test("sizes are clamped to 24 labels and 4 series", () => {
  const labels = Array.from({ length: 30 }, (_, i) => `W${i + 1}`);
  const series = Array.from({ length: 6 }, (_, s) => ({ name: `S${s}`, values: labels.map((_, i) => i * s) }));
  const chart = normalizeChart({ type: "line", labels, series, title: "x".repeat(200), unit: "%" });
  assert.ok(chart);
  assert.equal(chart.labels.length, 24);
  assert.equal(chart.series.length, 4);
  assert.equal(chart.series[0].values.length, 24);
  assert.equal(chart.title?.length, 80);
});

test("scales start at zero and land on round steps", () => {
  assert.deepEqual(niceScale(3, 87), { min: 0, max: 100, step: 25 });
  assert.deepEqual(niceScale(-12, 30), { min: -20, max: 40, step: 20 });
  assert.deepEqual(niceScale(0, 0), { min: 0, max: 1, step: 0.25 });
});

test("values are compact and carry the unit", () => {
  assert.equal(formatValue(1250000), "1.3M");
  assert.equal(formatValue(42, "%"), "42%");
  assert.equal(formatValue(12500, "USD"), "12.5k USD");
  assert.equal(formatValue(0.25), "0.25");
});

test("the summary is a readable text version of the data", () => {
  assert.equal(chartSummary(normalizeChart(sample)!), "Deals closed\nJan 3, Feb 5, Mar 2");
});

test("the svg escapes every text and draws one bar per value", () => {
  const chart = normalizeChart({ ...sample, title: "A & <B>", labels: ["<x>", "Feb", "Mar"] })!;
  const svg = sceneSvg(chartScene(chart));
  assert.ok(svg.startsWith("<svg xmlns=\"http://www.w3.org/2000/svg\""));
  assert.ok(!svg.includes("<x>") && !svg.includes("<B>"));
  assert.ok(svg.includes("A &amp; &lt;B&gt;"));
  assert.equal((svg.match(/<path [^>]*fill="#2a78d6"/g) ?? []).length, 3);
});

test("a line chart with two series gets a legend and one marker per point", () => {
  const scene = chartScene(normalizeChart({ type: "line", labels: ["Q1", "Q2", "Q3"], series: [{ name: "Maya", values: [1, 4, 2] }, { name: "Ada", values: [2, 2, 5] }] })!);
  assert.equal(scene.items.filter((item) => item.kind === "circle").length, 6);
  assert.ok(scene.items.some((item) => item.kind === "text" && item.text === "Ada"));
  assert.ok(sceneSvg(scene, "dark").includes("#3987e5"));
});

test("the compact size keeps the chart inside its smaller frame", () => {
  const chart = parseChart('{"type":"bar","labels":["Maya","Leo"],"series":[{"name":"Closed","values":[3,5]}]}')!;
  const scene = chartScene(chart, COMPACT_CHART);
  assert.equal(scene.width, COMPACT_CHART.width);
  assert.equal(scene.height, COMPACT_CHART.height);
  assert.ok(scene.items.every((item) => item.kind !== "text" || item.x <= COMPACT_CHART.width));
});
