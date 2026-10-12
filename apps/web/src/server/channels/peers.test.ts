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

test("a listed username is swapped for the account id that first used it", async () => {
  const { bindPeer } = await import("./peers");
  assert.equal(bindPeer("sam_example, 333333", "@Sam_Example", "222222"), "222222, 333333");
  assert.equal(bindPeer("333333", "sam_example", "222222"), null);
});
