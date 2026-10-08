import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionHasLabel, cleanLabelNames } from "../src/lib/labels";

/* the sidebar label filter's match + the demo backend's cleaning mirror
   (issue #174). The server-side cleaning is pinned by
   apps/server/test/session-labels.test.ts; cleanLabelNames here only keeps
   the in-browser demo honest with it. */

test("sessionHasLabel: case-insensitive membership, empty filter matches all", () => {
  assert.equal(sessionHasLabel(["bug", "Research"], null), true, "no filter = no filtering");
  assert.equal(sessionHasLabel(["bug", "Research"], "bug"), true);
  assert.equal(sessionHasLabel(["bug", "Research"], "BUG"), true, "the server's dedupe is case-insensitive; the filter is too");
  assert.equal(sessionHasLabel(["bug", "Research"], "research"), true);
  assert.equal(sessionHasLabel(["bug"], "ui"), false);
  assert.equal(sessionHasLabel(undefined, "bug"), false, "pre-labels rows carry no array");
  assert.equal(sessionHasLabel([], "bug"), false);
  assert.equal(sessionHasLabel(["bug"], "  "), true, "a blank filter is no filter");
});

test("cleanLabelNames: the demo mirror of the server's rules", () => {
  assert.deepEqual(cleanLabelNames([" bug ", "Research", "BUG", "", "ui"]), ["bug", "Research", "ui"]);
  assert.deepEqual(cleanLabelNames(Array.from({ length: 15 }, (_, i) => `tag-${i}`)).length, 8, "capped");
  assert.deepEqual(cleanLabelNames(["   ", "x".repeat(40)]), ["x".repeat(32)], "blanks dropped, 32-char cap");
});
