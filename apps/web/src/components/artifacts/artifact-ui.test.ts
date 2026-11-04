import assert from "node:assert/strict";
import { test } from "node:test";
import { artifactSearch, formatLabel, matchesQuery, nextZoom, readArtifactAddress, shelvesOf, splitTitle, ZOOM_STEPS } from "./artifact-ui";

test("zoom moves one step at a time and stops at both ends", () => {
  assert.equal(nextZoom(1, 1), 1.1);
  assert.equal(nextZoom(1, -1), 0.9);
  assert.equal(nextZoom(ZOOM_STEPS[0], -1), ZOOM_STEPS[0]);
  assert.equal(nextZoom(3, 1), 3);
  assert.equal(nextZoom(1.05, 1), 1.1);
});

test("pages artifacts are named after their format", () => {
  assert.equal(formatLabel("pages", "deck.pptx"), "Slides");
  assert.equal(formatLabel("pages", "contract.pdf"), "PDF");
  assert.equal(formatLabel("pages", "sheet.xlsx"), "Spreadsheet");
  assert.equal(formatLabel("html", "app.html"), "Interactive");
  assert.equal(formatLabel("markdown", "brief.md"), "Document");
});

test("the address only accepts artifact ids and positive versions", () => {
  assert.deepEqual(readArtifactAddress(new URLSearchParams("tab=artifacts&artifact=art_abc123XYZ&v=2")), { artifactId: "art_abc123XYZ", version: 2 });
  assert.deepEqual(readArtifactAddress(new URLSearchParams("artifact=art_abc123XYZ&v=0")), { artifactId: "art_abc123XYZ", version: null });
  assert.equal(readArtifactAddress(new URLSearchParams("artifact=javascript:alert(1)")), null);
  assert.equal(readArtifactAddress(new URLSearchParams("")), null);
});

test("opening an artifact keeps other params and switches to the artifacts tab", () => {
  assert.equal(artifactSearch("tab=files&x=1", { artifactId: "art_abc123XYZ", version: 3 }), "?tab=artifacts&x=1&artifact=art_abc123XYZ&v=3");
  assert.equal(artifactSearch("tab=artifacts&artifact=art_abc123XYZ&v=3", null), "?tab=artifacts");
  assert.equal(artifactSearch("", { artifactId: "art_abc123XYZ", version: null }), "?tab=artifacts&artifact=art_abc123XYZ");
});

test("a title opens with its shelf when a short name comes before a separator", () => {
  assert.deepEqual(splitTitle("Japonês · Aula 3 · Hiragana"), { shelf: "Japonês", rest: "Aula 3 · Hiragana" });
  assert.deepEqual(splitTitle("IA — Weight-space programming"), { shelf: "IA", rest: "Weight-space programming" });
  assert.deepEqual(splitTitle("Q3 board deck"), { shelf: null, rest: "Q3 board deck" });
  assert.deepEqual(splitTitle("Ends with a dot ·"), { shelf: null, rest: "Ends with a dot ·" });
  assert.deepEqual(splitTitle("Pricing-page-v2"), { shelf: null, rest: "Pricing-page-v2" });
});

test("search ignores case and accents and needs every word", () => {
  assert.equal(matchesQuery("Japonês · Aula 3 · Hiragana", "japones hira"), true);
  assert.equal(matchesQuery("Finanças · Aula 2 · Reserva", "FINANCAS reserva"), true);
  assert.equal(matchesQuery("Finanças · Aula 2 · Reserva", "reserva selic"), false);
  assert.equal(matchesQuery("Anything", "   "), true);
});

test("a shelf needs at least two artifacts and keeps the newest first", () => {
  const items = [
    { title: "Japonês · Aula 2 · Vogais" },
    { title: "Board deck" },
    { title: "japones · Aula 1 · Escrita" },
    { title: "Produto · Aula 1 · Jobs to be done" },
  ];
  const { shelves, loose } = shelvesOf(items);
  assert.equal(shelves.length, 1);
  assert.equal(shelves[0].name, "Japonês");
  assert.deepEqual(shelves[0].items.map((i) => i.title), ["Japonês · Aula 2 · Vogais", "japones · Aula 1 · Escrita"]);
  assert.deepEqual(loose.map((i) => i.title), ["Board deck", "Produto · Aula 1 · Jobs to be done"]);
});
