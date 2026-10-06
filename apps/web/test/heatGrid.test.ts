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

test("read-through: the grid rolls with time; the panel refetches on staleness", () => {
  const src = readFileSync(new URL("../src/panels/Inspectors.tsx", import.meta.url), "utf8");
  const grid = src.slice(src.indexOf("function HeatGrid"));
  assert.ok(!/new Date\(\)/.test(grid.slice(0, grid.indexOf("return ("))), "HeatGrid takes `now` as a prop — no internal once-per-render clock (midnight rollover rides the 30s tick)");
  const panel = src.slice(src.indexOf("function CostPanel"), src.indexOf("function HeatGrid"));
  assert.ok(/costsRefreshDue/.test(panel), "the panel refetches on the staleness rule, not only hydrated-view ticks (issue #158)");
});
