import assert from "node:assert/strict";
import { test } from "node:test";
import { deletes, parseGitRoute, pktLine, readPushRequest, refusedAdvertisement, refusedPush, sideband } from "./git-wire";

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const ZERO = "0".repeat(40);

function query(service?: string) {
  return new URLSearchParams(service ? { service } : {});
}

test("a route names one repository on github.com and one git service", () => {
  assert.deepEqual(parseGitRoute("/github.com/acme/widgets.git/info/refs", query("git-receive-pack")), { owner: "acme", repo: "widgets", service: "git-receive-pack", advertise: true });
  assert.deepEqual(parseGitRoute("/github.com/acme/widgets/git-upload-pack", query()), { owner: "acme", repo: "widgets", service: "git-upload-pack", advertise: false });
});

test("anything that is not a plain owner and repository is refused", () => {
  for (const path of ["/gitlab.com/acme/widgets.git/info/refs", "/github.com/acme/../widgets.git/info/refs", "/github.com/-acme/widgets.git/info/refs", "/github.com/acme/..git/info/refs", "/github.com/acme/wid gets/info/refs", "/github.com/acme/widgets.git/objects/info/packs"]) {
    assert.equal(parseGitRoute(path, query("git-upload-pack")), null, path);
  }
  assert.equal(parseGitRoute("/github.com/acme/widgets.git/info/refs", query()), null);
  assert.equal(parseGitRoute("/github.com/acme/widgets.git/info/refs", query("git-archive")), null);
});

test("the push commands and the client's capabilities are read before the pack", () => {
  const body = Buffer.concat([pktLine(`${OLD} ${NEW} refs/heads/main\0report-status side-band-64k agent=git/2.47\n`), pktLine(`${ZERO} ${NEW} refs/heads/feature\n`), Buffer.from("0000PACK...")]);
  assert.deepEqual(readPushRequest(body), {
    commands: [
      { oldId: OLD, newId: NEW, ref: "refs/heads/main" },
      { oldId: ZERO, newId: NEW, ref: "refs/heads/feature" },
    ],
    capabilities: ["report-status", "side-band-64k", "agent=git/2.47"],
  });
  assert.deepEqual(readPushRequest(Buffer.from("0000")), { commands: [], capabilities: [] });
});

test("a push that cannot be read is not guessed at", () => {
  assert.equal(readPushRequest(Buffer.from("")), null);
  assert.equal(readPushRequest(Buffer.from("zzzz")), null);
  assert.equal(readPushRequest(pktLine(`${OLD} ${NEW} refs/heads/main\n`)), null);
  assert.equal(readPushRequest(Buffer.concat([pktLine(`${OLD} ${NEW} heads/main\n`), Buffer.from("0000")])), null);
});

test("a deletion is a push whose new id is all zeros", () => {
  assert.equal(deletes({ oldId: OLD, newId: ZERO, ref: "refs/heads/feature" }), true);
  assert.equal(deletes({ oldId: ZERO, newId: NEW, ref: "refs/heads/feature" }), false);
});

test("a refused advertisement ends in an ERR line git shows as a remote error", () => {
  assert.equal(refusedAdvertisement("git-receive-pack", "no\nway").toString(), "001f# service=git-receive-pack\n0000000fERR no way\n");
});

test("a refused push reports every ref as rejected, inside the side band when the client asked for it", () => {
  const request = { commands: [{ oldId: OLD, newId: NEW, ref: "refs/heads/main" }], capabilities: ["report-status"] };
  assert.equal(refusedPush(request, "not today").toString(), "000eunpack ok\n0021ng refs/heads/main not today\n0000");
  const banded = refusedPush({ ...request, capabilities: ["report-status", "side-band-64k"] }, "not today");
  assert.ok(banded.toString().startsWith("000f\x02not today\n"));
  assert.ok(banded.toString().endsWith("0000"));
  assert.equal(sideband(1, Buffer.alloc(2000)).length, 3 * 5 + 2000);
});
