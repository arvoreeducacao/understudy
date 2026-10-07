import assert from "node:assert/strict";
import { test } from "node:test";
import { advancedTabs, agentTabPath, barTabs, parseTab, tabSearch, tabsFor } from "./workspace-tabs";

test("an owner can open every tab", () => {
  assert.equal(parseTab("terminal", true), "terminal");
  assert.equal(parseTab("settings", true), "settings");
  assert.equal(tabsFor(true).length, 8);
});

test("a teammate only gets the computer and the tasks", () => {
  assert.equal(parseTab("tasks", false), "tasks");
  assert.equal(parseTab("terminal", false), "computer");
  assert.equal(parseTab("logins", false), "computer");
});

test("an unknown or missing tab lands on the computer", () => {
  assert.equal(parseTab(null, true), "computer");
  assert.equal(parseTab("nope", true), "computer");
});

test("the computer tab keeps the address clean and other params survive", () => {
  assert.equal(tabSearch("", "computer"), "");
  assert.equal(tabSearch("?tab=files", "computer"), "");
  assert.equal(tabSearch("?tab=files&x=1", "jobs"), "?tab=jobs&x=1");
  assert.equal(tabSearch("x=1", "computer"), "?x=1");
});

test("the old pages redirect into their tab", () => {
  assert.equal(agentTabPath("agt_1", "terminal"), "/agents/agt_1?tab=terminal");
  assert.equal(agentTabPath("agt_1", "computer"), "/agents/agt_1");
});

test("the terminal stays out of the tab bar and lives under More", () => {
  assert.equal(barTabs(true, "computer").includes("terminal"), false);
  assert.deepEqual(advancedTabs(true), ["terminal"]);
  assert.equal(barTabs(true, "computer").length, 7);
});

test("an open terminal shows in the bar so the page still says where you are", () => {
  assert.equal(barTabs(true, "terminal").includes("terminal"), true);
});

test("a teammate gets no advanced tools", () => {
  assert.deepEqual(advancedTabs(false), []);
  assert.deepEqual(barTabs(false, "computer"), ["computer", "tasks"]);
});
