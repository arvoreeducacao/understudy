import assert from "node:assert/strict";
import { test } from "node:test";
import { accessChangeAllowed, canManageConnector, canUseConnector, startingAccess } from "./connector-rights";

const admin = { id: "u_admin", email: "admin@example.com", admin: true };
const ana = { id: "u_ana", email: "Ana@example.com", admin: false };
const bia = { id: "u_bia", email: "bia@example.com", admin: false };

test("a connector added by an admin starts open to everyone", () => {
  assert.equal(startingAccess(admin), null);
});

test("a connector added by anyone else starts as theirs alone", () => {
  assert.deepEqual(startingAccess(ana), ["ana@example.com"]);
  const row = { createdBy: ana.id, allowedEmails: startingAccess(ana) };
  assert.equal(canUseConnector(ana, row), true);
  assert.equal(canUseConnector(bia, row), false);
  assert.equal(canUseConnector(admin, row), true);
});

test("only who added it, or an admin, manages a connector", () => {
  const row = { createdBy: ana.id, allowedEmails: null };
  assert.equal(canManageConnector(ana, row), true);
  assert.equal(canManageConnector(bia, row), false);
  assert.equal(canManageConnector(admin, row), true);
  assert.equal(canManageConnector(ana, { createdBy: null, allowedEmails: null }), false);
});

test("only admins open a connector to everyone", () => {
  assert.equal(accessChangeAllowed(ana, true), false);
  assert.equal(accessChangeAllowed(ana, false), true);
  assert.equal(accessChangeAllowed(admin, true), true);
});
