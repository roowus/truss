import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* SPEC-TESTS for the cost heatmap going stale + GitHub-style cell info —
   https://github.com/roowus/truss/issues/158
   ("The heatmap in the cost/tokens tab seems static — not updating with the
   times. Also make it like GitHub: hovering a box says the date + info").
   These FAIL on purpose today: they pin the contract a fix must satisfy.

   Investigated (Inspectors.tsx CostPanel):
   - data refetches only on mount + a tick that counts llm.call.dones in
     HYDRATED views only — work in chats you haven't opened (or while the
     panel sits open overnight) never refreshes it; and the grid computes
     `new Date()` internally once per render, so "today" doesn't roll.
   - cells DO carry a native `title` (slow, unstyled) — not the GitHub-style
     instant styled tooltip the user means.

   The contract:

   1. src/lib/heatGrid.ts —

        heatTooltip(day: { day, calls, tokensIn, tokensOut, costUsd }): string
          → "Mon Oct 6 · 12 calls · 45.2k tokens · $0.31" (cost omitted when
            null; zero-days read "No usage" — GitHub's phrasing);

        costsRefreshDue({ lastFetchAt, now, staleAfterMs? }): boolean
          → time-based staleness, independent of which sessions are open.

   2. read-through: HeatGrid receives `now` as a prop (rolls at midnight on
      the 30s tick — no internal new Date()), and the panel refetches on the
      staleness rule, not only on hydrated-view ticks. */

interface HeatGridModule {
  heatTooltip(day: { day: string; calls: number; tokensIn: number; tokensOut: number; costUsd: number | null }): string;
  costsRefreshDue(input: { lastFetchAt: number; now: number; staleAfterMs?: number }): boolean;
  clampTipPos(
    anchor: { left: number; top: number; width: number; height: number },
    tip: { width: number; height: number },
    wrap: { width: number; height: number },
  ): { left: number; top: number };
}

async function load(): Promise<HeatGridModule | null> {
  const spec = "../src/lib/heatGrid"; // variable specifier: typechecks before the module exists
  return import(spec).catch(() => null);
}

test("src/lib/heatGrid.ts exists", async () => {
  const mod = await load();
  assert.ok(mod, "src/lib/heatGrid.ts must export heatTooltip + costsRefreshDue — see issue #158");
});

test("heatTooltip: GitHub-style text — date, calls, tokens, cost; honest zero-days", async () => {
  const mod = await load();
  assert.ok(mod, "heatGrid module must exist (see module test)");

  const tip = mod.heatTooltip({ day: "2026-10-05", calls: 12, tokensIn: 40000, tokensOut: 5200, costUsd: 0.31 });
  assert.match(tip, /Oct 5/, "the date, human");
  assert.match(tip, /12 calls/, "the call count");
  assert.match(tip, /45(.2)?k/i, "tokens abbreviated");
  assert.match(tip, /\$0\.31/, "the cost");

  const noCost = mod.heatTooltip({ day: "2026-10-04", calls: 3, tokensIn: 100, tokensOut: 50, costUsd: null });
  assert.ok(!noCost.includes("$"), "cost omitted when unknown — never $null");

  const zero = mod.heatTooltip({ day: "2026-10-03", calls: 0, tokensIn: 0, tokensOut: 0, costUsd: null });
  assert.match(zero, /no usage|no calls/i, "GitHub's honest zero-day phrasing");
  assert.match(zero, /Oct 3/, "still dated");
});

test("costsRefreshDue: time-based staleness — hydration-independent", async () => {
  const mod = await load();
  assert.ok(mod, "heatGrid module must exist (see module test)");

  assert.equal(mod.costsRefreshDue({ lastFetchAt: 1000, now: 1000 + 30_000 }), false, "fresh");
  assert.equal(mod.costsRefreshDue({ lastFetchAt: 1000, now: 1000 + 120_000 }), true, "stale after the window (default ≤ 2min)");
  assert.equal(mod.costsRefreshDue({ lastFetchAt: 0, now: 5 }), true, "never fetched → due");
});

test("clampTipPos: centered on the cell, clamped inside the grid, above by default", async () => {
  const mod = await load();
  assert.ok(mod, "heatGrid module must exist (see module test)");
  const clamp = mod.clampTipPos;
  const tip = { width: 200, height: 22 };

  // roomy grid: tooltip sits centered above the cell, fully inside
  const mid = clamp({ left: 100, top: 50, width: 12, height: 12 }, tip, { width: 400, height: 140 });
  assert.equal(mid.left, 6, "centered on the cell");
  assert.equal(mid.top, 50 - 22 - 6, "above the cell");
  assert.ok(mid.left >= 0 && mid.left + tip.width <= 400, "inside horizontally");
  assert.ok(mid.top >= 0, "inside vertically");

  // cells near the left edge can no longer spill past it (the reported clip)
  const leftEdge = clamp({ left: 2, top: 50, width: 12, height: 12 }, tip, { width: 240, height: 140 });
  assert.equal(leftEdge.left, 0, "slid inside the left edge");

  // cells near the right edge can no longer spill past it either
  const rightEdge = clamp({ left: 340, top: 50, width: 12, height: 12 }, tip, { width: 360, height: 140 });
  assert.equal(rightEdge.left, 360 - tip.width, "slid inside the right edge");

  // top row flips below instead of clipping above
  const topRow = clamp({ left: 100, top: 2, width: 12, height: 12 }, tip, { width: 400, height: 140 });
  assert.equal(topRow.top, 2 + 12 + 6, "flipped below the cell");

  // a flipped-below tooltip near the bottom is nudged back inside
  const squeezed = clamp({ left: 100, top: 16, width: 12, height: 12 }, tip, { width: 400, height: 40 });
  assert.ok(squeezed.top + tip.height <= 40 && squeezed.top >= 0, "nudged inside vertically");
});

test("read-through: the grid rolls with time; the panel refetches on staleness", () => {
  const src = readFileSync(new URL("../src/panels/Inspectors.tsx", import.meta.url), "utf8");
  const grid = src.slice(src.indexOf("function HeatGrid"));
  assert.ok(!/new Date\(\)/.test(grid.slice(0, grid.indexOf("return ("))), "HeatGrid takes `now` as a prop — no internal once-per-render clock (midnight rollover rides the 30s tick)");
  const panel = src.slice(src.indexOf("function CostPanel"), src.indexOf("function HeatGrid"));
  assert.ok(/costsRefreshDue/.test(panel), "the panel refetches on the staleness rule, not only hydrated-view ticks (issue #158)");
  /* audit round 1 B1: the styled tooltip replaced the native title, which was
     at least focus-surfaced — the cell must keep that reachability */
  const cells = grid.slice(grid.indexOf("return ("), grid.indexOf("CredentialsPanel"));
  assert.ok(/role="img"/.test(cells) && /tabIndex=\{0\}/.test(cells), "cells expose their tooltip info to keyboard/AT: role + tabIndex, tooltip shows on focus too");
  /* the developer reported the per-cell tooltips clipping at the panel edge
     on narrow docks (PR #165 session note, 2026-10-06 — not an audit round):
     one shared tooltip, clamped inside the grid wrapper, shown for hovered
     AND focused cells */
  assert.ok(/onMouseEnter=/.test(cells) && /onFocus=/.test(cells), "the tooltip shows for hovered and keyboard-focused cells alike");
  assert.ok(/clampTipPos\(/.test(grid) && /relative/.test(cells), "the shared tooltip is positioned by clampTipPos inside a relative grid wrapper");
});
