import { test } from "node:test";
import assert from "node:assert/strict";

/* Companion tests for issue #225 — the cases the spec-test
   (test/multiSelect.test.ts, the authoritative contract) does not pin.
   The spec-test is committed unchanged; these add coverage for the two
   regressions most likely to bite:

     1. ranges follow the VISIBLE order — with a search filter active, a
        shift-click must select the visible rows between the two clicks and
        NOTHING hidden. This is the whole reason applyClick takes `order`
        instead of reading some underlying array.
     2. a STALE id — one still in the selection but no longer among the
        items (its row vanished between render and click) — must never
        enable an action whose target is gone.

   They also pin the reusability contract #226 depends on: ids are opaque
   strings and the model is kind-agnostic. */

import type { BulkAction, ClickMods, SelectionState } from "../src/lib/multiSelect";
import { applyClick, bulkActions, createSelection, pruneSelection } from "../src/lib/multiSelect";

/* the sidebar renders every session/shell/host in one flat visible order;
   a search filter drops rows out of it */
const ALL = ["s1", "s2", "s3", "t1", "h1"];
const FILTERED = ["s1", "s3"]; /* s2/t1/h1 are hidden by the search box */

test("shift ranges follow the VISIBLE order, never the underlying array", () => {
  let sel = applyClick(createSelection(), "s1", {}, FILTERED);
  sel = applyClick(sel, "s3", { shift: true }, FILTERED);
  assert.deepEqual(
    [...sel.ids].sort(),
    ["s1", "s3"],
    "the range covers exactly the visible rows between the clicks — the hidden s2/t1/h1 are not swept up",
  );
  assert.ok(!sel.ids.has("s2"), "a filtered-out row must never enter the selection");
  assert.ok(!sel.ids.has("t1") && !sel.ids.has("h1"), "…nor rows below the fold");

  /* the same ids in the UNFILTERED order do make a wide range — proving the
     difference comes from `order`, not from the ids themselves */
  const wide = applyClick(applyClick(createSelection(), "s1", {}, ALL), "h1", { shift: true }, ALL);
  assert.deepEqual([...wide.ids], ["s1", "s2", "s3", "t1", "h1"], "with nothing hidden the range spans the list");

  /* a filtered-out ANCHOR degrades to a plain click instead of inventing a
     range the user cannot see */
  const anchorGone = applyClick(applyClick(createSelection(), "s2", {}, ALL), "s3", { shift: true }, FILTERED);
  assert.deepEqual([...anchorGone.ids], ["s3"], "an anchor outside the visible order falls back to a plain click");
  assert.equal(anchorGone.anchor, "s3");
});

test("repeated shift-clicks re-range from the stable anchor (no marching)", () => {
  let sel = applyClick(createSelection(), "s2", {}, ALL);
  sel = applyClick(sel, "h1", { shift: true }, ALL);
  assert.deepEqual([...sel.ids], ["s2", "s3", "t1", "h1"], "first range");
  sel = applyClick(sel, "s3", { shift: true }, ALL);
  assert.deepEqual([...sel.ids], ["s2", "s3"], "shrinking re-ranges off the same anchor — t1/h1 drop out");
  assert.equal(sel.anchor, "s2", "the anchor never moved");
});

test("a stale id never enables an action whose target is gone", () => {
  /* s2 was selected, then its row vanished (deleted/archived away) while the
     selection still held the id — exactly the render/click race */
  let sel = applyClick(applyClick(createSelection(), "s1", {}, ALL), "s2", { shift: true }, ALL);
  assert.deepEqual([...sel.ids], ["s1", "s2"]);

  const live = [{ id: "s1", kind: "session" }]; /* s2 is gone from items */
  const acts = bulkActions(sel, live);
  const del = acts.find((a) => a.id === "delete")!;
  assert.ok(del, "actions are still computed off the live rows");
  assert.ok(
    !/2 (chats|items)/.test(del.label),
    `the count must reflect live rows only, got "${del.label}"`,
  );
  assert.ok(del.confirm, "one live session still deletes with the two-click gate");

  /* the whole selection stale → no live rows → no actions at all */
  assert.deepEqual(bulkActions(sel, []), [], "everything gone → no actions, not dead buttons");

  /* and pruneSelection is what actually cleans it up on the next render */
  const pruned = pruneSelection(sel, ["s1"]);
  assert.deepEqual([...pruned.ids], ["s1"]);
  assert.equal(pruned.anchor, "s1");
  assert.deepEqual([...pruneSelection(sel, []).ids], [], "no survivors → empty set");
  assert.equal(pruneSelection(sel, []).anchor, null, "…and no anchor");
});

test("the model is kind-agnostic — any opaque id works (#226 reuses it)", () => {
  /* File-tree style ids, a tree's expanded visible order, and a mixed-kind
     selection all go through the same functions untouched */
  const treeOrder = ["src/", "src/a.ts", "src/b.ts", "docs/", "docs/readme.md"];
  let sel = applyClick(createSelection(), "src/a.ts", {}, treeOrder);
  sel = applyClick(sel, "docs/readme.md", { shift: true }, treeOrder);
  assert.deepEqual(
    [...sel.ids],
    ["src/a.ts", "src/b.ts", "docs/", "docs/readme.md"],
    "the same range semantics the Files tree needs (#226)",
  );
  sel = applyClick(sel, "docs/", { meta: true }, treeOrder);
  assert.deepEqual([...sel.ids].sort(), ["docs/readme.md", "src/a.ts", "src/b.ts"], "toggle off, anchor moves");

  const mixed: BulkAction[] = bulkActions(
    applyClick(applyClick(createSelection(), "s1", {}, ALL), "h1", { shift: true }, ALL),
    [
      { id: "s1", kind: "session" },
      { id: "s2", kind: "session" },
      { id: "s3", kind: "session" },
      { id: "t1", kind: "shell" },
      { id: "h1", kind: "host" },
    ],
  );
  const del = mixed.find((a) => a.id === "delete")!;
  assert.ok(del.disabled, "a session+shell+host set disables delete");
  assert.match(del.disabled!, /mixed/i, "…with the reason spelled out");
  assert.ok(mixed.some((a) => a.id === "pin" && !a.disabled), "pin still spans the mixed set");
  assert.ok(!mixed.some((a) => a.id === "archive" && !a.disabled), "archive is chat-only and says so");

  /* a single-kind shell set deletes by killing — its own honest verb */
  const shells = bulkActions(
    applyClick(createSelection(), "t1", {}, ALL),
    [{ id: "t1", kind: "shell" }],
  );
  assert.deepEqual(shells.map((a) => a.id), ["pin", "archive", "delete"]);
  assert.equal(shells.find((a) => a.id === "delete")!.disabled, undefined, "one live shell → delete is live");

  /* never throws on garbage */
  assert.doesNotThrow(() => applyClick(createSelection(), "x", { meta: true }, []));
  assert.doesNotThrow(() => pruneSelection(createSelection(), []));
  assert.doesNotThrow(() => bulkActions(createSelection(), []));
  assert.deepEqual(bulkActions(createSelection(), []), [], "nothing selected → no actions");
});

test("modifier typing: the exported names #226 imports exist", () => {
  /* Type-level contract — a compile failure here is the test failing. #226
     imports these instead of redeclaring its own copies. */
  const mods: ClickMods = { shift: true };
  const sel: SelectionState = createSelection();
  const acts: BulkAction[] = bulkActions(sel, []);
  assert.deepEqual(acts, []);
  assert.equal(mods.shift, true);
  assert.equal(sel.anchor, null);
});
