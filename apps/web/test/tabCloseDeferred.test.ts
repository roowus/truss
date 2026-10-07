import { test } from "node:test";
import assert from "node:assert/strict";

/* SPEC-TESTS for deferred tab-strip resize on close —
   https://github.com/roowus/truss/issues/197
   ("Like Chrome: closing a tab doesn't immediately resize the rest — they
   shift over at the same widths so spam-closing keeps the X under my
   cursor; when I stop, they animate back to fit"). These FAIL on purpose
   today: they pin the contract a fix must satisfy.

   Chrome's actual rule: while the pointer is over the tab strip, a close
   FREEZES the remaining tabs at their pre-close widths (the gap collects at
   the strip's right end — the next tab's X slides under the cursor); when
   the pointer LEAVES the strip (or a settle delay passes with no further
   closes), the tabs animate to their computed uniform widths (#95's
   chromeTabLayout).

   The contract: chromeTabs.ts gains —

     tabCloseWidths(prevWidths: number[], closedIndex: number, computed: number[], hot: boolean): number[]

   - hot (pointer over the strip, just closed) → prevWidths MINUS the closed
     entry (frozen — the strip runs short at the right, nothing shifts size);
   - not hot (pointer left / settled) → `computed` (the fresh uniform
     layout), ready for the stretch animation;
   - closing the active/last/first all behave; degenerate inputs never
     throw.

   Plus the invariant the whole feature exists for — measured on the
   freeze: the next tab's close-X center lands within the X's own width of
   where the closed one's was. */

interface CloseDeferredModule {
  tabCloseWidths(prevWidths: number[], closedIndex: number, computed: number[], hot: boolean): number[];
}

async function load(): Promise<CloseDeferredModule | null> {
  const spec = "../src/lib/chromeTabs"; // the module exists; the export is the contract
  const mod: any = await import(spec);
  return typeof mod?.tabCloseWidths === "function" ? mod : null;
}

test("chromeTabs.ts exports tabCloseWidths", async () => {
  const mod = await load();
  assert.ok(mod, "src/lib/chromeTabs.ts must export tabCloseWidths — see issue #197");
});

test("hot: widths freeze and the gap collects at the right; settled: computed widths return", async () => {
  const mod = await load();
  assert.ok(mod, "tabCloseWidths must exist (see module test)");

  const prev = [140, 140, 140, 140, 140]; // five crowded tabs
  const computed = [175, 175, 175, 175]; // what the layout wants once one closes

  const frozen = mod.tabCloseWidths(prev, 1, computed, true);
  assert.deepEqual(frozen, [140, 140, 140, 140], "hot strip: the closed tab leaves, everyone KEEPS their width — nothing resizes under the cursor");

  const settled = mod.tabCloseWidths(prev, 1, computed, false);
  assert.deepEqual(settled, computed, "pointer gone (or settled) → the computed fit — the stretch-back animates to this");

  /* edge cases never throw */
  assert.deepEqual(mod.tabCloseWidths([140], 0, [], true), [], "closing the only tab");
  assert.deepEqual(mod.tabCloseWidths(prev, 0, computed, true), [140, 140, 140, 140], "closing the first");
  assert.deepEqual(mod.tabCloseWidths(prev, 4, computed, true), [140, 140, 140, 140], "closing the last");
  assert.doesNotThrow(() => mod.tabCloseWidths([], 0, [], false));
});

test("the spam-click invariant: the next X lands where the last one was", async () => {
  const mod = await load();
  assert.ok(mod, "tabCloseWidths must exist (see module test)");

  /* uniform frozen widths: tab i's box starts at i*w; its X sits at a fixed
     offset from the box's right edge. Close tab i with the cursor on its
     X → the tab at i+1 shifts into index i → ITS X lands at the same x. */
  const w = 140;
  const xOffsetFromRight = 14; // the X's resting inset (any sane value)
  const xCenter = (i: number, width: number) => i * width + width - xOffsetFromRight;

  const prev = [w, w, w, w, w];
  const closedX = xCenter(2, w);
  const frozen = mod.tabCloseWidths(prev, 2, [175, 175, 175, 175], true);
  /* the strip is now [w,w,w,w] — the tab that WAS index 3 is now index 2 */
  const nextX = 2 * frozen[2] + frozen[2] - xOffsetFromRight;
  assert.ok(Math.abs(nextX - closedX) <= xOffsetFromRight, `the next X is under the cursor (|${nextX} - ${closedX}| ≤ the X's width)`);

  /* and a second spam click: same story again */
  const frozen2 = mod.tabCloseWidths(frozen, 2, [233, 233, 233], true);
  const nextX2 = 2 * frozen2[2] + frozen2[2] - xOffsetFromRight;
  assert.ok(Math.abs(nextX2 - closedX) <= xOffsetFromRight, "and again — the cursor never chases");
});
