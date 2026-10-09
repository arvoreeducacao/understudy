import assert from "node:assert/strict";
import { test } from "node:test";
import { fileKind, latestOutputs } from "./outputs";

test("the card shows the newest deliveries first, three at most", () => {
  const files = [
    { path: "a.xlsx", size: 1, updatedAt: 10 },
    { path: "b.docx", size: 1, updatedAt: 40 },
    { path: "c.pdf", size: 1, updatedAt: 30 },
    { path: "d.png", size: 1, updatedAt: 20 },
  ];
  assert.deepEqual(
    latestOutputs(files).map((file) => file.path),
    ["b.docx", "c.pdf", "d.png"],
  );
  assert.equal(files[0].path, "a.xlsx");
});

test("each delivery gets a short label by its extension", () => {
  assert.deepEqual(fileKind("reports/open-invoices.XLSX"), { label: "XLS", tone: "sheet" });
  assert.deepEqual(fileKind("notes.md"), { label: "DOC", tone: "doc" });
  assert.deepEqual(fileKind("deck.pptx"), { label: "PPT", tone: "deck" });
  assert.deepEqual(fileKind("archive.zip"), { label: "ZIP", tone: "other" });
  assert.deepEqual(fileKind("README"), { label: "FILE", tone: "other" });
  assert.deepEqual(fileKind("v1.2/notes"), { label: "FILE", tone: "other" });
});
