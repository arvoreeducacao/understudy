import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanPeerList, peerListed } from "./peers";

test("allowed lists keep only identifiers that fit the channel", () => {
  assert.equal(cleanPeerList("telegram", "@Sam_Example, 123456789, ab, 12, sam_example"), "sam_example, 123456789");
  assert.equal(cleanPeerList("whatsapp", "+1 (555) 010-0000, 5550100001, abc"), "+15550100000, +5550100001");
});

test("a peer matches by any of its identifiers", () => {
  assert.equal(peerListed("telegram", ["222222", "Sam_Example"], "sam_example"), true);
  assert.equal(peerListed("telegram", ["222222", ""], "sam_example"), false);
});
