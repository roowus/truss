import { test } from "node:test";
import assert from "node:assert/strict";

/* SPEC-TESTS for pin-first ordering — https://github.com/roowus/truss/issues/86
   ("Add pinning: chats, shells, etc."). These FAIL on purpose today.

   The sidebar applies ONE ordering rule to every section: pinned first,
   everything else keeps its existing order (recency for chats, insertion
   for shells, creation for hosts). The contract: a pure, non-mutating
   src/lib/pinSort.ts —

     sortWithPinned<T>(items: T[], isPinned?: (item: T) => boolean): T[]
       // default key: (item as {pinned}).pinned === true

   Rules: stable partition (never reorders within pinned/unpinned), input
   array never mutated, degenerate inputs sane. */

interface PinSortModule {
  sortWithPinned<T>(items: T[], isPinned?: (item: T) => boolean): T[];
}

async function load(): Promise<PinSortModule | null> {
  const spec = "../src/lib/pinSort"; // variable specifier: typechecks before the module exists
  return import(spec).catch(() => null);
}

test("src/lib/pinSort.ts exists", async () => {
  const mod = await load();
  assert.ok(mod, "src/lib/pinSort.ts must export sortWithPinned — see issue #86");
});

test("pinned first, stable within both partitions", async () => {
  const mod = await load();
  assert.ok(mod, "pinSort module must exist (see module test)");
  const rows = [
    { id: "a", pinned: false },
    { id: "b", pinned: true },
    { id: "c", pinned: false },
    { id: "d", pinned: true },
    { id: "e", pinned: false },
  ];
  assert.deepEqual(
    mod.sortWithPinned(rows).map((r) => r.id),
    ["b", "d", "a", "c", "e"],
    "pinned float in their existing relative order; the rest never shuffle",
  );
});

test("never mutates the input; degenerate inputs sane; custom key honored", async () => {
  const mod = await load();
  assert.ok(mod, "pinSort module must exist (see module test)");

  const rows = [{ id: "a", pinned: false }, { id: "b", pinned: true }];
  const before = rows.map((r) => r.id);
  mod.sortWithPinned(rows);
  assert.deepEqual(rows.map((r) => r.id), before, "input array untouched");

  assert.deepEqual(mod.sortWithPinned([]), [], "empty in, empty out");
  assert.deepEqual(
    mod.sortWithPinned([{ id: "x" }, { id: "y" }]).map((r) => r.id),
    ["x", "y"],
    "nothing pinned → identity",
  );
  assert.deepEqual(
    mod.sortWithPinned([{ id: "x" }, { id: "y" }], (r) => r.id === "y").map((r) => r.id),
    ["y", "x"],
    "custom key works (e.g. hosts' revived flag)",
  );
});
