import { test } from "node:test";
import assert from "node:assert/strict";
import { decideStrip, computeTabStrip } from "../src/lib/tabSizing";

/* Regression pin for the component-side glue (pr-audit B2): the tab size
   manager identified the caller's tab via a `data-tab-panel-id` DOM
   attribute that NOTHING in the app or dockview-core ever sets, so `mine`
   was always null and the cramped/ultra verdicts never reached the
   component — the close button stayed inline + always-visible no matter
   how squeezed the strip got (the #8/#21 behavior was dead at runtime
   while the pure-function spec tests stayed green).

   decideStrip makes the glue pure and identity-based: the caller's tab is
   matched by ELEMENT IDENTITY (shell === mine), and the verdict rides that
   same match back out. These tests run the glue with plain-object shells —
   no DOM needed. */

interface FakeShell {
  name: string;
}

const SHELLS: FakeShell[] = [{ name: "a" }, { name: "b" }, { name: "c" }];

/* crowded strip: 3 tabs, 400px — natural total (3 × 180 standard) exceeds
   the strip, so inactive tabs are cramped */
const crowded = () =>
  decideStrip({
    stripWidth: 400,
    tabs: [
      { shell: SHELLS[0], naturalWidth: 132, active: true },
      { shell: SHELLS[1], naturalWidth: 208, active: false },
      { shell: SHELLS[2], naturalWidth: 96, active: false },
    ],
    mine: SHELLS[1],
    prev: { cramped: false, ultra: false },
  });

test("the verdict reaches the caller's tab, matched by shell identity (no attribute)", () => {
  const { verdict } = crowded();
  assert.ok(verdict, "a tab whose shell IS in the strip always gets a verdict");
  assert.equal(verdict.cramped, true, "the squeezed inactive tab learns it is cramped");
  assert.equal(verdict.ultra, false);
});

test("a DIFFERENT shell object with equal-looking data is not a match", () => {
  const { verdict } = decideStrip({
    stripWidth: 400,
    tabs: [
      { shell: SHELLS[0], naturalWidth: 132, active: true },
      { shell: SHELLS[1], naturalWidth: 208, active: false },
    ],
    mine: { name: "a" }, // structurally identical, not the same element
    prev: { cramped: false, ultra: false },
  });
  assert.equal(verdict, null, "identity, not structure — a foreign shell gets no verdict");
});

test("widths come back keyed to the shells, in order, for every tab", () => {
  const { widths } = crowded();
  assert.deepEqual(widths.map((w) => w.shell), SHELLS, "one width per shell, in scan order");
  for (const { width } of widths) assert.ok(Number.isFinite(width) && width > 0);
  assert.equal(widths[1].width, widths[2].width, "inactives compress uniformly (#23)");
  assert.ok(widths[0].width >= widths[1].width, "active is widest");
});

test("prev history is attached to the CALLER's tab only — stickiness follows the identity match", () => {
  /* strip just inside the deadband: natural total is 2 × 180 = 360, so
     360 < 380 < 360 + 48 — prev=false says roomy, prev=true stays cramped */
  const prevTrue = decideStrip({
    stripWidth: 380,
    tabs: [
      { shell: SHELLS[0], naturalWidth: 132, active: false },
      { shell: SHELLS[1], naturalWidth: 208, active: false },
    ],
    mine: SHELLS[1],
    prev: { cramped: true, ultra: false },
  });
  assert.equal(prevTrue.verdict?.cramped, true, "the caller's own prev makes ITS verdict sticky");
  const prevFalse = decideStrip({
    stripWidth: 380,
    tabs: [
      { shell: SHELLS[0], naturalWidth: 132, active: false },
      { shell: SHELLS[1], naturalWidth: 208, active: false },
    ],
    mine: SHELLS[0],
    prev: { cramped: false, ultra: false },
  });
  assert.equal(prevFalse.verdict?.cramped, false, "another tab's history never leaks in");
});

test("agrees with computeTabStrip on the same strip (the glue adds identity, not new rules)", () => {
  const glue = crowded();
  const pure = computeTabStrip({
    stripWidth: 400,
    tabs: [
      { id: "0", naturalWidth: 132, active: true },
      { id: "1", naturalWidth: 208, active: false, prevCramped: false, prevUltra: false },
      { id: "2", naturalWidth: 96, active: false },
    ],
  });
  assert.deepEqual(glue.verdict, pure.verdicts["1"]);
  assert.equal(glue.widths[0].width, pure.widths["0"]);
  assert.equal(glue.widths[2].width, pure.widths["2"]);
});
