import { test } from "node:test";
import assert from "node:assert/strict";

/* REGRESSION for audit B4 on PR #60 (issue #23: "focused tab always fully
   displayed"): the close-X / cramped verdicts never recomputed on tab
   activation. Workspace.tsx's measure effect closed over `active` without
   listing it in its deps, and the strip verdict was composed as
   `crampedVerdict(...) && !active` from that stale closure — so a clicked
   tab kept its compressed inactive-share width and the inactive-tab overlay
   X (and the blurred tab kept the active-tab inline X) until an unrelated
   resize/title/pending change happened to re-measure.

   The fix has two halves; these tests pin the half this harness (node, no
   DOM) can reach — the verdict is a pure function of the tab's ROLE, so a
   focus change is a new input, not a closure the effect can go stale on:

     crampedForTab(prev, naturalPx, stripPx, active): boolean
       active tab   → never cramped (its X stays inline+always — #23 rule)
       inactive tab → the strip verdict (sticky, per issue #21)

   The other half is wiring: `active` in the Workspace.tsx measure effect's
   deps, so activation re-runs the strip layout. There is no dockview DOM
   harness in this repo (audit noted the gap); the deps line carries a
   comment naming this regression so it isn't "cleaned up" back out. */

import { crampedForTab, crampedVerdict, TAB_CHROME_PX, TAB_CRAMPED_HYSTERESIS_PX } from "../src/lib/tabClose";

test("crampedForTab: the ACTIVE tab is never cramped, even in an overcrowded strip", () => {
  const natural = 5 * 180; // five standard tabs
  const strip = 400; // way overcrowded — the strip verdict is cramped
  assert.equal(crampedVerdict(false, natural, strip), true, "precondition: the strip IS cramped");
  assert.equal(crampedForTab(false, natural, strip, true), false, "the focused tab composes roomy — inline X, always visible");
  assert.equal(crampedForTab(false, natural, strip, false), true, "inactive tabs follow the strip verdict");
});

test("crampedForTab: the verdict FLIPS with the role at identical measurements", () => {
  /* the B4 shape: same strip, same widths — only the focus moved. The
     verdict is a function of `active`, so the flip is immediate, not
     deferred to the next unrelated re-measure */
  const natural = 4 * 180;
  const strip = 500; // overcrowded
  const asInactive = crampedForTab(false, natural, strip, false);
  const asActive = crampedForTab(false, natural, strip, true);
  assert.equal(asInactive, true);
  assert.equal(asActive, false);
  assert.notEqual(asInactive, asActive, "activation alone must change the verdict — the stale closure is the bug");
});

test("crampedForTab: roomy strips stay roomy for both roles", () => {
  const natural = 2 * 180;
  const strip = 1000;
  assert.equal(crampedForTab(false, natural, strip, false), false);
  assert.equal(crampedForTab(false, natural, strip, true), false);
});

test("crampedForTab: the inactive tab keeps the issue #21 hysteresis", () => {
  const natural = 4 * 180;
  const inside = natural + TAB_CRAMPED_HYSTERESIS_PX - 1; // inside the deadband
  const past = natural + TAB_CRAMPED_HYSTERESIS_PX; // past it
  assert.equal(crampedForTab(true, natural, inside, false), true, "the previous verdict stands inside the band");
  assert.equal(crampedForTab(true, natural, past, false), false, "and releases past it");
  assert.equal(crampedForTab(true, natural, inside, true), false, "the active role overrides even inside the band");
});

test("TAB_CHROME_PX: the probe→natural-width chrome constant is exported and matches isOvercrowded's default", async () => {
  /* Workspace.tsx builds every tab's naturalWidth as probe + TAB_CHROME_PX;
     the strip verdict in tabClose.ts must count the same chrome or the two
     crowding tests disagree about when the strip overflows */
  const { isOvercrowded } = await import("../src/lib/tabClose");
  assert.equal(typeof TAB_CHROME_PX, "number");
  assert.ok(TAB_CHROME_PX > 0);
  const probes = [100, 100];
  const strip = 2 * (100 + TAB_CHROME_PX); // exactly natural-with-chrome
  assert.equal(isOvercrowded(probes, strip + 10), false, "fits at natural+chrome → roomy");
  assert.equal(isOvercrowded(probes, strip - 10), true, "short of natural+chrome → crowded");
});
