import { test } from "node:test";
import assert from "node:assert/strict";

/* SPEC-TESTS for sidebar multi-select — https://github.com/roowus/truss/issues/225
   ("Allow shift-select and cmd-select multiple shells or sessions in the
   sidebar"). These FAIL on purpose today: they pin the contract a fix must
   satisfy.

   Today the sidebar has no selection model at all — rows act alone
   (per-row confirm-delete, per-row pin). Multi-select enables bulk actions.

   The contract: src/lib/multiSelect.ts —

     createSelection(): { ids: Set<string>; anchor: string | null }

     applyClick(sel, id, mods, order): SelectionState
       - plain click: select exactly `id` (anchor = id);
       - shift: RANGE from anchor → id in the visible `order` (anchor stays);
       - meta/ctrl: toggle `id` (anchor = id);
       - shift with no anchor: behaves like a plain click;
       - order-missing ids: still selectable (defensive), ranges clamp;
     pruneSelection(sel, liveIds): SelectionState
       - rows that vanish (deleted/archived away) drop out; empty → no anchor;
     bulkActions(sel, items): { id: string; label: string; disabled?: string }[]
       - the actions that apply to the WHOLE set (archive/delete/pin…), each
         with a reason when disabled (e.g. mixed kinds). */

interface SelectionState {
  ids: Set<string>;
  anchor: string | null;
}
interface MultiSelectModule {
  createSelection(): SelectionState;
  applyClick(
    sel: SelectionState,
    id: string,
    mods: { shift?: boolean; meta?: boolean; ctrl?: boolean },
    order: string[],
  ): SelectionState;
  pruneSelection(sel: SelectionState, liveIds: string[]): SelectionState;
  bulkActions(sel: SelectionState, items: { id: string; kind: string }[]): { id: string; label: string; disabled?: string }[];
}

async function load(): Promise<MultiSelectModule | null> {
  const spec = "../src/lib/multiSelect"; // variable specifier: typechecks before the module exists
  return import(spec).catch(() => null);
}

const ORDER = ["a", "b", "c", "d", "e"];

test("src/lib/multiSelect.ts exists", async () => {
  const mod = await load();
  assert.ok(mod, "src/lib/multiSelect.ts must export the selection model — see issue #225");
});

test("plain / shift / meta clicks behave like every list on the web", async () => {
  const mod = await load();
  assert.ok(mod, "multiSelect module must exist (see module test)");

  let sel = mod.createSelection();
  assert.deepEqual([...sel.ids], [], "empty start");

  sel = mod.applyClick(sel, "b", {}, ORDER);
  assert.deepEqual([...sel.ids], ["b"], "plain click selects one");
  assert.equal(sel.anchor, "b");

  sel = mod.applyClick(sel, "d", { shift: true }, ORDER);
  assert.deepEqual([...sel.ids].sort(), ["b", "c", "d"], "shift extends the RANGE from the anchor");
  assert.equal(sel.anchor, "b", "the anchor stays put for further shift-clicks");

  sel = mod.applyClick(sel, "a", { shift: true }, ORDER);
  assert.deepEqual([...sel.ids].sort(), ["a", "b"], "shifting ABOVE the anchor works too");

  sel = mod.applyClick(sel, "d", { meta: true }, ORDER);
  assert.deepEqual([...sel.ids].sort(), ["a", "b", "d"], "meta toggles membership");
  assert.equal(sel.anchor, "d", "meta-click moves the anchor");

  sel = mod.applyClick(sel, "d", { ctrl: true }, ORDER);
  assert.deepEqual([...sel.ids].sort(), ["a", "b"], "ctrl toggles off");

  sel = mod.applyClick(sel, "c", {}, ORDER);
  assert.deepEqual([...sel.ids], ["c"], "a plain click collapses to one");

  const noAnchor = mod.applyClick(mod.createSelection(), "c", { shift: true }, ORDER);
  assert.deepEqual([...noAnchor.ids], ["c"], "shift with no anchor behaves plainly");
});

test("pruning: vanished rows drop; bulk actions reflect the set", async () => {
  const mod = await load();
  assert.ok(mod, "multiSelect module must exist (see module test)");

  let sel = mod.applyClick(mod.applyClick(mod.createSelection(), "a", {}, ORDER), "c", { shift: true }, ORDER);
  assert.deepEqual([...sel.ids].sort(), ["a", "b", "c"]);
  const pruned = mod.pruneSelection(sel, ["a", "c"]);
  assert.deepEqual([...pruned.ids].sort(), ["a", "c"], "b vanished → pruned");
  assert.equal(mod.pruneSelection(sel, []).anchor, null, "everything gone → no anchor");

  const acts = mod.bulkActions(pruned, [
    { id: "a", kind: "session" },
    { id: "c", kind: "session" },
  ]);
  assert.ok(acts.some((a) => /archive/i.test(a.label)), "bulk archive offered");
  assert.ok(acts.some((a) => /delete|trash/i.test(a.label)), "bulk delete offered");
  assert.ok(acts.every((a) => a.label.length > 0));

  const mixed = mod.bulkActions(pruned, [
    { id: "a", kind: "session" },
    { id: "c", kind: "host" },
  ]);
  const del = mixed.find((a) => /delete|trash/i.test(a.label));
  assert.ok(!del || del.disabled, "mixed kinds disable the destructive bulk action WITH a reason");
  assert.equal(mod.bulkActions(mod.createSelection(), []).length, 0, "nothing selected → no actions");
});
