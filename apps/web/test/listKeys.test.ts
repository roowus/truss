import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* SPEC-TESTS for arrow-key navigation — https://github.com/roowus/truss/issues/227
   ("I should be able to navigate menus, files, etc. with the arrow keys").
   These FAIL on purpose today: they pin the contract a fix must satisfy.

   The contract: ONE roving-focus model, src/lib/listKeys.ts —

     nextIndex(current: number, count: number, key: string, opts?: { wrap?: boolean }): number
       — ArrowDown/ArrowUp move (with wrap when asked — menus wrap,
         sidebar/file lists clamp); Home/End jump; anything else is a
         no-op; empty lists → -1; current -1 (nothing focused) enters at
         the top for ArrowDown / the bottom for ArrowUp;
     typeaheadIndex(items: string[], query: string, from?: number): number
       — the standard menu jump: the next item starting with `query`
         (case-insensitive), searching from `from` and wrapping;

   and the surfaces drive it: the Select/menu components (roving focus) and
   the Files tree (Up/Down through visible rows, Enter opens). */

interface ListKeysModule {
  nextIndex(current: number, count: number, key: string, opts?: { wrap?: boolean }): number;
  typeaheadIndex(items: string[], query: string, from?: number): number;
}

async function load(): Promise<ListKeysModule | null> {
  const spec = "../src/lib/listKeys"; // variable specifier: typechecks before the module exists
  return import(spec).catch(() => null);
}

test("src/lib/listKeys.ts exists", async () => {
  const mod = await load();
  assert.ok(mod, "src/lib/listKeys.ts must export nextIndex/typeaheadIndex — see issue #227");
});

test("nextIndex: arrows, Home/End, wrap vs clamp, entry from nothing, no-ops", async () => {
  const mod = await load();
  assert.ok(mod, "listKeys module must exist (see module test)");

  assert.equal(mod.nextIndex(0, 5, "ArrowDown"), 1);
  assert.equal(mod.nextIndex(4, 5, "ArrowDown"), 4, "lists clamp at the end");
  assert.equal(mod.nextIndex(4, 5, "ArrowDown", { wrap: true }), 0, "menus wrap");
  assert.equal(mod.nextIndex(0, 5, "ArrowUp"), 0, "clamp at the top");
  assert.equal(mod.nextIndex(0, 5, "ArrowUp", { wrap: true }), 4);

  assert.equal(mod.nextIndex(2, 5, "Home"), 0);
  assert.equal(mod.nextIndex(2, 5, "End"), 4);

  assert.equal(mod.nextIndex(-1, 5, "ArrowDown"), 0, "entering with nothing focused starts at the top");
  assert.equal(mod.nextIndex(-1, 5, "ArrowUp"), 4, "…or the bottom when arrowing up");
  assert.equal(mod.nextIndex(2, 5, "Enter"), 2, "non-navigation keys are no-ops");
  assert.equal(mod.nextIndex(2, 0, "ArrowDown"), -1, "empty list");
  assert.doesNotThrow(() => mod.nextIndex(2, 5, ""));
});

test("typeaheadIndex: the menu jump — case-insensitive, from-where-you-are, wrapping", async () => {
  const mod = await load();
  assert.ok(mod, "listKeys module must exist (see module test)");
  const items = ["Archive", "Close", "Copy to research", "Move to ops", "Pin"];

  assert.equal(mod.typeaheadIndex(items, "c"), 1, "first match");
  assert.equal(mod.typeaheadIndex(items, "co"), 2, "'co' narrows to the first 'Co…'");
  assert.equal(mod.typeaheadIndex(items, "m"), 3);
  assert.equal(mod.typeaheadIndex(items, "p"), 4);
  assert.equal(mod.typeaheadIndex(items, "p", 5), 4, "searches from the current focus and wraps to it");
  assert.equal(mod.typeaheadIndex(items, "zzz"), -1, "no match");
  assert.equal(mod.typeaheadIndex(items, ""), -1, "empty query");
});

test("read-through: menus and the Files tree drive the shared model", () => {
  const menu = readFileSync(new URL("../src/components/ui.tsx", import.meta.url), "utf8");
  assert.ok(
    /listKeys|nextIndex/.test(menu),
    "the menu components (Select/MenuItem) must support arrow navigation — today only the mouse works (issue #227)",
  );
  const files = readFileSync(new URL("../src/panels/FilesPanel.tsx", import.meta.url), "utf8");
  assert.ok(/listKeys|nextIndex/.test(files), "the Files tree navigates with the arrows too");
});
