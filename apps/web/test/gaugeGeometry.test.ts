import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* SPEC-TESTS for the Monitor gauge clipping — https://github.com/roowus/truss/issues/157
   ("The circle statistic indicators at the top of the monitor tab are
   slightly cut off on all four sides"). These FAIL on purpose today: they
   pin the contract a fix must satisfy.

   The bug is one line of arithmetic (MonitorPanel.tsx Gauge): viewBox
   64×64, circle r=30, strokeWidth=6 → the stroke's outer edge sits at
   r + strokeWidth/2 = 33 > 32 — clipped on every side, always.

   The contract: a pure gauge geometry helper — src/lib/gaugeGeometry.ts —

     gaugeRing({ size, strokeWidth }): { r, cx, cy }

   with the invariant the renderer must never break:

     r + strokeWidth / 2 + EDGE_PAD <= size / 2      (EDGE_PAD ≥ 1px)

   …and a read-through that MonitorPanel's Gauge satisfies it (or uses the
   helper). */

interface GaugeGeometryModule {
  gaugeRing(input: { size: number; strokeWidth: number }): { r: number; cx: number; cy: number };
}

async function load(): Promise<GaugeGeometryModule | null> {
  const spec = "../src/lib/gaugeGeometry"; // variable specifier: typechecks before the module exists
  return import(spec).catch(() => null);
}

test("src/lib/gaugeGeometry.ts exists with the no-clip invariant", async () => {
  const mod = await load();
  assert.ok(mod, "src/lib/gaugeGeometry.ts must export gaugeRing — see issue #157");
});

test("the invariant holds across sizes/strokes; degenerate inputs never throw", async () => {
  const mod = await load();
  assert.ok(mod, "gaugeGeometry module must exist (see module test)");

  for (const [size, sw] of [[64, 6], [48, 4], [96, 8], [32, 3]] as const) {
    const g = mod.gaugeRing({ size, strokeWidth: sw });
    assert.ok(g.r + sw / 2 + 1 <= size / 2, `size=${size} sw=${sw}: the stroke fits INSIDE the viewBox (r=${g.r}) — never clipped`);
    assert.equal(g.cx, size / 2, "centered");
    assert.equal(g.cy, size / 2);
    assert.ok(g.r > 0, "a real ring");
  }
  assert.doesNotThrow(() => mod.gaugeRing({ size: 0, strokeWidth: 0 }));
  assert.doesNotThrow(() => mod.gaugeRing({ size: -5, strokeWidth: 2 }));
});

test("read-through: MonitorPanel's Gauge can never clip again", () => {
  const src = readFileSync(new URL("../src/panels/MonitorPanel.tsx", import.meta.url), "utf8");
  const gauge = src.slice(src.indexOf("function Gauge"));
  assert.ok(
    /gaugeRing\(/.test(gauge),
    "the Gauge's ring geometry must come from gaugeRing — today r=30 + strokeWidth 6 in a 64 box = the stroke's outer edge at 33 > 32, clipped on all four sides (issue #157)",
  );
});
