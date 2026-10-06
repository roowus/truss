import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* SPEC-TESTS for readable monitor graphs — https://github.com/roowus/truss/issues/161
   ("When I hover a graph I want the exact data point value — not blind —
   and units on the side, like an actual graph"). These FAIL on purpose
   today: they pin the contract a fix must satisfy.

   Today (Inspectors.tsx Spark / MonitorPanel SparkCard): a bare SVG path —
   no axes, no units, no interaction. Values are normalized 0..1 (cpu/mem as
   fractions of 100; net divided by its own max — units lost entirely).

   The contract: a pure src/lib/sparkline.ts —

     sparkScale(points, { domain?, unit }): { min, max, ticks: { value, label }[] }
       — the y domain + 2–4 labeled ticks. Pinned domains (percent: 0–100)
         win; otherwise data min..max with padding; a FLAT series still
         produces a sane non-zero span; labels carry the unit;
     sparkHoverIndex(length, xFraction): number
       — pointer x (0..1) → the NEAREST data index, clamped to the ends;
     sparkPointLabel(point, { at, unit }): string
       — the tooltip text ("42% · 14:03" / "182 kB/s · 14:03"). */

interface SparklineModule {
  sparkScale(points: number[], opts: { domain?: [number, number]; unit: string }): { min: number; max: number; ticks: { value: number; label: string }[] };
  sparkHoverIndex(length: number, xFraction: number): number;
  sparkPointLabel(point: number, opts: { at: number; unit: string }): string;
}

async function load(): Promise<SparklineModule | null> {
  const spec = "../src/lib/sparkline"; // variable specifier: typechecks before the module exists
  return import(spec).catch(() => null);
}

test("src/lib/sparkline.ts exists", async () => {
  const mod = await load();
  assert.ok(mod, "src/lib/sparkline.ts must export sparkScale/sparkHoverIndex/sparkPointLabel — see issue #161");
});

test("sparkScale: pinned domains, padded auto domains, units on every tick, flat-series safety", async () => {
  const mod = await load();
  assert.ok(mod, "sparkline module must exist (see module test)");

  const pct = mod.sparkScale([0.2, 0.42, 0.9], { domain: [0, 1], unit: "%" });
  assert.deepEqual([pct.min, pct.max], [0, 1], "the pinned percent domain");
  assert.ok(pct.ticks.length >= 2 && pct.ticks.length <= 4, "a few ticks, not a ladder");
  assert.ok(pct.ticks.every((t) => t.label.includes("%")), "units on the side — the ask");
  assert.ok(pct.ticks.some((t) => t.label === "100%"), "the top tick reads the unit's max");

  const net = mod.sparkScale([1200, 48000, 9000], { unit: "B/s" });
  assert.ok(net.min <= 1200 && net.max >= 48000, "auto domain covers the data");
  assert.ok(net.max > 48000, "with headroom — the peak never kisses the top");
  assert.ok(net.ticks.every((t) => /kB|MB|B\/s/.test(t.label)), "rates format with real units");

  const flat = mod.sparkScale([7, 7, 7], { unit: "%" });
  assert.ok(flat.max > flat.min, "a flat series never divides by zero");
  assert.ok(flat.ticks.every((t) => Number.isFinite(t.value)), "finite ticks");
});

test("sparkHoverIndex: pointer x snaps to the NEAREST point, clamped", async () => {
  const mod = await load();
  assert.ok(mod, "sparkline module must exist (see module test)");

  assert.equal(mod.sparkHoverIndex(11, 0), 0, "left edge");
  assert.equal(mod.sparkHoverIndex(11, 1), 10, "right edge");
  assert.equal(mod.sparkHoverIndex(11, 0.46), 5, "nearest (not floor) — 0.46×10 = 4.6 → 5");
  assert.equal(mod.sparkHoverIndex(1, 0.5), 0, "a single point");
  assert.equal(mod.sparkHoverIndex(0, 0.5), -1, "empty series → no point");
  assert.equal(mod.sparkHoverIndex(11, -3), 0, "out-of-range clamps");
});

test("sparkPointLabel: the exact value + the time + the unit", async () => {
  const mod = await load();
  assert.ok(mod, "sparkline module must exist (see module test)");

  const label = mod.sparkPointLabel(0.42, { at: Date.UTC(2026, 9, 6, 14, 3), unit: "%" });
  assert.match(label, /42%/, "the exact value, not a guess");
  assert.match(label, /14:03/, "and when");
  const rate = mod.sparkPointLabel(182000, { at: Date.UTC(2026, 9, 6, 14, 3), unit: "B/s" });
  assert.match(rate, /18[02](\.\d)?\s*kB\/s|0\.1[78]\s*MB\/s/, "rates humanize");
});

test("read-through: the monitor's sparks render ticks + hover wiring", () => {
  const src = readFileSync(new URL("../src/panels/Inspectors.tsx", import.meta.url), "utf8");
  const spark = src.slice(src.indexOf("export function Spark"));
  assert.ok(
    /sparkScale\(|sparkHoverIndex\(/.test(spark),
    "Spark must drive its scale/hover from sparkline.ts — today it's a bare path with normalized values and zero interaction (issue #161)",
  );
});
