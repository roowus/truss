import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* SPEC-TESTS for the tab's trailing reserve — https://github.com/roowus/truss/issues/125
   ("The alive/waiting dot on a non-focused tab sits flush at the tab's right
   edge with no padding"). These FAIL on purpose today: they pin the
   contract a fix must satisfy.

   Why (investigated, Workspace.tsx:217): the tab row is icon → title
   (flex-1) → StateDot → badge → X. The X is hover-only on inactive tabs
   (the #95 Chrome matrix), so on an unfocused tab the DOT is the last
   element — flush against the edge, zero padding.

   Chrome-parity answer: the X's slot is RESERVED when it's hover-hidden
   and an indicator (dot/badge) is showing — the dot keeps breathing room
   AND hover-revealing the X can't shift anything (the #21 no-shift spirit).

   The contract: chromeTabs.ts gains —

     tabTrailingReserve(view: ChromeTabView, hasIndicator: boolean): number

   - showClose "always" → 0 (the X occupies the slot);
   - showClose "hover"/"never" + indicator showing → the X slot width
     (18–26px band) so the dot never touches the edge;
   - no title (sliver) or no indicator → 0 (the title fades to the edge). */

interface ChromeTabsTrailing {
  tabTrailingReserve(view: { showTitle: boolean; showClose: "always" | "hover" | "never" }, hasIndicator: boolean): number;
}

async function load(): Promise<ChromeTabsTrailing | null> {
  const spec = "../src/lib/chromeTabs"; // the module exists; the export is the contract
  const mod: any = await import(spec);
  return typeof mod?.tabTrailingReserve === "function" ? mod : null;
}

test("chromeTabs.ts exports tabTrailingReserve", async () => {
  const mod = await load();
  assert.ok(mod, "src/lib/chromeTabs.ts must export tabTrailingReserve — see issue #125");
});

test("the reserve matrix: X-inline → none; hover/never + indicator → the X slot; sliver/bare → none", async () => {
  const mod = await load();
  assert.ok(mod, "tabTrailingReserve must exist (see module test)");

  assert.equal(mod.tabTrailingReserve({ showTitle: true, showClose: "always" }, true), 0, "the pinned X IS the trailing element");

  const reserved = mod.tabTrailingReserve({ showTitle: true, showClose: "hover" }, true);
  assert.ok(reserved >= 18 && reserved <= 26, `the X's slot stays reserved (got ${reserved}px) — the dot breathes and hover can't shift the row`);
  assert.equal(mod.tabTrailingReserve({ showTitle: true, showClose: "never" }, true), reserved, "tight-inactive tabs (no X ever) get the same breathing room");

  assert.equal(mod.tabTrailingReserve({ showTitle: false, showClose: "hover" }, true), 0, "slivers show no dot — no reserve");
  assert.equal(mod.tabTrailingReserve({ showTitle: true, showClose: "hover" }, false), 0, "no indicator → the title fades to the edge (Chrome)");
});

test("read-through: the dot's row actually carries the reserve", () => {
  const src = readFileSync(new URL("../src/components/Workspace.tsx", import.meta.url), "utf8");
  assert.ok(
    /tabTrailingReserve\(/.test(src),
    "the tab row must apply tabTrailingReserve — today the dot is the last element on unfocused tabs and kisses the right edge",
  );
});
