import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeLayoutSizes } from "../src/lib/layoutSanitize";

/* a narrow-window moment once squeezed split groups to 2px and that layout
   restored forever — phantom groups whose headers painted over neighbors */

const leaf = (size: number, extra: Record<string, unknown> = {}) => ({ type: "leaf", size, data: { id: `p${size}` }, ...extra });

test("phantom 2px group is floored to the minimum, siblings rescaled, budget kept", () => {
  const layout = {
    grid: {
      orientation: "HORIZONTAL",
      width: 900,
      root: { type: "branch", size: 900, data: [leaf(896), leaf(2), leaf(2)] },
    },
  };
  const out = normalizeLayoutSizes(layout);
  const sizes = out.grid.root.data.map((k: { size: number }) => k.size);
  assert.ok(sizes[1] >= 120 && sizes[2] >= 120, `phantoms floored: ${sizes}`);
  const sum = sizes.reduce((a: number, b: number) => a + b, 0);
  assert.ok(Math.abs(sum - 900) < 1, `budget preserved: ${sum}`);
  assert.ok(sizes[0] > 0 && sizes[0] < 896, "big sibling paid for it");
});

test("nested branches alternate axes (height clamp inside a horizontal split)", () => {
  const layout = {
    grid: {
      orientation: "HORIZONTAL",
      width: 800,
      root: {
        type: "branch",
        size: 800,
        data: [
          leaf(400),
          {
            type: "branch",
            size: 400,
            data: [leaf(700), leaf(1)], // vertical split: heights
          },
        ],
      },
    },
  };
  const out = normalizeLayoutSizes(layout);
  const nested = (out.grid.root.data[1] as { data: { size: number }[] }).data.map((k) => k.size);
  assert.ok(nested[1] >= 60, `height floored: ${nested}`);
  assert.ok(Math.abs(nested[0] + nested[1] - 701) < 1, `nested budget kept: ${nested}`);
  assert.ok(nested[0] > 640, "the tall sibling paid only the deficit");
});

test("healthy layout is untouched (idempotent)", () => {
  const layout = {
    grid: {
      orientation: "HORIZONTAL",
      width: 1000,
      root: { type: "branch", size: 1000, data: [leaf(500), leaf(500)] },
    },
  };
  const once = normalizeLayoutSizes(structuredClone(layout));
  const twice = normalizeLayoutSizes(structuredClone(once));
  assert.deepEqual(once, twice);
  assert.deepEqual(once.grid.root.data.map((k: { size: number }) => k.size), [500, 500]);
});

test("invisible (closed) children keep their zero size", () => {
  const layout = {
    grid: {
      orientation: "HORIZONTAL",
      width: 900,
      root: { type: "branch", size: 900, data: [leaf(900), leaf(0, { visible: false })] },
    },
  };
  const out = normalizeLayoutSizes(layout);
  assert.equal(out.grid.root.data[1].size, 0, "invisible child not inflated");
  assert.equal(out.grid.root.data[0].size, 900);
});

test("garbage in, same object out (no grid, no root, non-branch root)", () => {
  assert.equal(normalizeLayoutSizes(null), null);
  assert.deepEqual(normalizeLayoutSizes({}), {});
  const leafRoot = { grid: { orientation: "HORIZONTAL", width: 500, root: leaf(500) } };
  assert.deepEqual(normalizeLayoutSizes(leafRoot), leafRoot);
});

test("budget smaller than the floors: proportional shrink, nothing negative or NaN", () => {
  const layout = {
    grid: {
      orientation: "HORIZONTAL",
      width: 100, // 4 groups in 100px — impossible to honor 120px floors
      root: { type: "branch", size: 100, data: [leaf(25), leaf(25), leaf(25), leaf(25)] },
    },
  };
  const out = normalizeLayoutSizes(layout);
  const sizes = out.grid.root.data.map((k: { size: number }) => k.size);
  for (const s of sizes) {
    assert.ok(Number.isFinite(s) && s > 0, `sane size ${s}`);
  }
  assert.ok(Math.abs(sizes.reduce((a: number, b: number) => a + b, 0) - 100) < 1, "budget kept");
});

test("missing/zero child sizes get rebuilt from the allocation", () => {
  const layout = {
    grid: {
      orientation: "HORIZONTAL",
      width: 600,
      root: { type: "branch", size: 600, data: [leaf(0), leaf(0)] },
    },
  };
  const out = normalizeLayoutSizes(layout);
  const sizes = out.grid.root.data.map((k: { size: number }) => k.size);
  assert.ok(sizes.every((s: number) => s >= 120), `rebuilt: ${sizes}`);
});
