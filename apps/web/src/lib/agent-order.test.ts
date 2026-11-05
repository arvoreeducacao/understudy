import assert from "node:assert/strict";
import { test } from "node:test";
import { applyAgentOrder, mergeAgentOrder, moveInGroup, sameOrder } from "./agent-order";

const agents = ["lemon", "grape", "blueberry", "orange"].map((id) => ({ id }));
const ids = (list: { id: string }[]) => list.map((agent) => agent.id);

test("without a saved order the list keeps the order it came in", () => {
  assert.deepEqual(ids(applyAgentOrder(agents, null)), ["lemon", "grape", "blueberry", "orange"]);
  assert.deepEqual(ids(applyAgentOrder(agents, [])), ["lemon", "grape", "blueberry", "orange"]);
});

test("a saved order wins, and agents it does not know come first in the order they came in", () => {
  assert.deepEqual(ids(applyAgentOrder(agents, ["orange", "grape", "gone"])), ["lemon", "blueberry", "orange", "grape"]);
});

test("saving keeps agents the list did not show next to the one they followed", () => {
  const allowed = new Set(["a", "b", "c", "x", "y"]);
  assert.deepEqual(mergeAgentOrder(["x", "a", "b", "y", "c"], ["c", "a", "b"], allowed), ["x", "c", "a", "b", "y"]);
  assert.deepEqual(mergeAgentOrder(null, ["b", "a"], allowed), ["b", "a"]);
});

test("saving drops ids the person cannot see, repeats and anything that is not a string", () => {
  const allowed = new Set(["a", "b"]);
  assert.deepEqual(mergeAgentOrder(["stale", "a"], ["b", "b", 7, "someone-else", "a"], allowed), ["b", "a"]);
});

test("moving stays inside the agent's own group", () => {
  const groups: Record<string, string> = { a: "mine", b: "mine", c: "mine", s: "shared", t: "shared" };
  const groupOf = (id: string) => groups[id];
  assert.deepEqual(moveInGroup(["a", "b", "c", "s", "t"], "c", 0, groupOf), ["c", "a", "b", "s", "t"]);
  assert.deepEqual(moveInGroup(["a", "b", "c", "s", "t"], "a", 9, groupOf), ["b", "c", "a", "s", "t"]);
  assert.deepEqual(moveInGroup(["a", "b", "c", "s", "t"], "t", 0, groupOf), ["a", "b", "c", "t", "s"]);
});

test("sameOrder compares position by position", () => {
  assert.equal(sameOrder(["a", "b"], ["a", "b"]), true);
  assert.equal(sameOrder(["a", "b"], ["b", "a"]), false);
  assert.equal(sameOrder(["a"], ["a", "b"]), false);
});
