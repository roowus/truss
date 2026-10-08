import { test } from "node:test";
import assert from "node:assert/strict";

/* SPEC-TESTS for label chip rendering — https://github.com/roowus/truss/issues/174
   ("GitHub-style labels on sessions"). These FAIL on purpose today.

   The web-side contract: src/lib/labels.ts —

     labelColor(name): string
       — a deterministic palette color per name (same label, same color,
         every render — GitHub-style auto-color), always a usable css color;
     labelChips(labels, maxVisible?): { shown: string[]; overflow: number }
       — the row's chips: first N, then a "+k" overflow count; never more
         than the cap on screen. */

interface LabelsModule {
  labelColor(name: string): string;
  labelChips(labels: string[], maxVisible?: number): { shown: string[]; overflow: number };
}

async function load(): Promise<LabelsModule | null> {
  const spec = "../src/lib/labels"; // variable specifier: typechecks before the module exists
  return import(spec).catch(() => null);
}

test("src/lib/labels.ts exists", async () => {
  const mod = await load();
  assert.ok(mod, "src/lib/labels.ts must export labelColor + labelChips — see issue #174");
});

test("labelColor: deterministic, palette-safe, collision-sane", async () => {
  const mod = await load();
  assert.ok(mod, "labels module must exist (see module test)");

  assert.equal(mod.labelColor("research"), mod.labelColor("research"), "deterministic — same label, same color");
  assert.equal(mod.labelColor("research"), mod.labelColor("Research"), "case-insensitive identity");
  assert.match(mod.labelColor("research"), /^(#[0-9a-f]{3,8}|var\(|hsl|oklch|color-mix)/i, "a usable css color");
  const palette = new Set(["research", "bug", "ui", "ops", "fleet", "macbook", "perf", "docs"].map((l) => mod.labelColor(l)));
  assert.ok(palette.size >= 6, `the palette spreads (got ${palette.size}/8 distinct)`);
  assert.doesNotThrow(() => mod.labelColor(""));
});

test("labelChips: capped display with an honest overflow count", async () => {
  const mod = await load();
  assert.ok(mod, "labels module must exist (see module test)");

  assert.deepEqual(mod.labelChips(["a", "b"], 3), { shown: ["a", "b"], overflow: 0 });
  const many = mod.labelChips(["a", "b", "c", "d", "e"], 2);
  assert.deepEqual(many.shown, ["a", "b"], "the cap holds");
  assert.equal(many.overflow, 3, "the +3 is honest");
  assert.deepEqual(mod.labelChips([], 3), { shown: [], overflow: 0 });
  assert.deepEqual(mod.labelChips(["x"]), { shown: ["x"], overflow: 0 }, "sane default cap");
});
