import assert from "node:assert/strict";
import { test } from "node:test";

process.env.BETTER_AUTH_SECRET ??= "test-secret";

test("an approval link names one approval, cannot be forged and expires", async () => {
  const { approvalLinkToken, readApprovalLinkToken } = await import("./approval-link");
  const now = Date.parse("2026-10-11T12:00:00Z");
  const token = approvalLinkToken("apr_abcdefghijkl", now);
  assert.equal(readApprovalLinkToken(token, now), "apr_abcdefghijkl");
  assert.equal(readApprovalLinkToken(token.replace("apr_abcdefghijkl", "apr_zzzzzzzzzzzz"), now), null);
  assert.equal(readApprovalLinkToken(`${token}x`, now), null);
  assert.equal(readApprovalLinkToken(token, now + 25 * 60 * 60 * 1000), null);
  assert.equal(readApprovalLinkToken("apr_abcdefghijkl.9999999999.", now), null);
  assert.throws(() => approvalLinkToken("../etc", now));
});
