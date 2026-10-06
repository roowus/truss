import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* SPEC-TESTS for junction drags releasing — https://github.com/roowus/truss/issues/192
   ("Dragging a junction: even after I release the mouse it keeps following
   — worst with 4 panels / 2 junctions"). These FAIL on purpose today: they
   pin the contract a fix must satisfy.

   Why it happens (investigated, SplitJunctions.tsx): the drag's move/up
   handlers live on the HANDLE ELEMENT with pointer capture as the only
   release path — while the drag's own setSize calls fire
   onDidLayoutChange → refresh() → the handles re-render mid-drag (new
   objects, moving boxes). If the element churns (a transient key change —
   groupIdOf's "?" fallback — or a remount), capture dies with it, the
   pointerup never lands, dragRef stays set, and the next hover over the
   fresh handle keeps applying the stale drag. Two junctions make the churn
   constant (dragging one re-places the other).

   The contract:

   1. a pure drag session — src/lib/splitJunction.ts gains

        startJunctionDrag(grid, junction, apply): {
          move(dx, dy): void;   // applies via the callback
          end(): void;          // settles — idempotent, any path
          active(): boolean;
        }

      after end(): moves are no-ops; end is safe to call twice;
      cancel/blur settle exactly like pointerup;

   2. read-through: SplitJunctions.tsx drives the drag with WINDOW-level
      listeners (attached on pointerdown, torn down on end) — never
      handle-element-only handlers whose element can churn mid-drag. */

interface JunctionDragModule {
  startJunctionDrag(
    grid: unknown,
    junction: unknown,
    apply: (dx: number, dy: number) => void,
  ): { move(dx: number, dy: number): void; end(): void; active(): boolean };
}

async function load(): Promise<JunctionDragModule | null> {
  const spec = "../src/lib/splitJunction"; // the module exists; the export is the contract
  const mod: any = await import(spec);
  return typeof mod?.startJunctionDrag === "function" ? mod : null;
}

test("splitJunction.ts exports startJunctionDrag", async () => {
  const mod = await load();
  assert.ok(mod, "src/lib/splitJunction.ts must export startJunctionDrag — see issue #192");
});

test("release actually releases: moves after end are no-ops; end is idempotent", async () => {
  const mod = await load();
  assert.ok(mod, "startJunctionDrag must exist (see module test)");

  const applied: [number, number][] = [];
  const drag = mod.startJunctionDrag({}, {}, (dx, dy) => applied.push([dx, dy]));

  drag.move(10, 5);
  assert.equal(applied.length, 1, "drags apply while active");
  assert.equal(drag.active(), true);

  drag.end();
  assert.equal(drag.active(), false, "ended");
  drag.move(99, 99);
  assert.equal(applied.length, 1, "NOTHING applies after release — the stuck drag dies here (issue #192)");

  assert.doesNotThrow(() => drag.end(), "double-end is safe (pointerup + pointercancel + blur can all land)");
  assert.equal(applied.length, 1, "no phantom apply from the extra end");
});

test("read-through: the drag listens on WINDOW during the gesture, not only the churnable handle", () => {
  const src = readFileSync(new URL("../src/components/SplitJunctions.tsx", import.meta.url), "utf8");
  assert.ok(/startJunctionDrag/.test(src), "the component drives the session object");
  assert.ok(
    /window\.addEventListener\("pointer(move|up)"/.test(src) || /addEventListener\(.pointermove/.test(src),
    "move/up ride window-level listeners attached at drag start — a remounting handle can never orphan the drag again",
  );
});
