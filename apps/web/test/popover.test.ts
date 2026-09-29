import { test } from "node:test";
import assert from "node:assert/strict";
import { clampPopoverPos } from "../src/lib/popover";

/* the model picker clipped off-screen when its button sat near the right
   edge (popover was anchored left with no viewport clamp) */

const anchor = { left: 767, right: 937, top: 100, bottom: 124 };

test("normal case: left-aligned to the anchor, below it", () => {
  const pos = clampPopoverPos({ left: 100, right: 200, top: 50, bottom: 74 }, 283, 280, 1400, 900);
  assert.deepEqual(pos, { left: 100, top: 79 });
});

test("regression: near the right edge the popover shifts left, never past viewport-8", () => {
  // the exact reported geometry: 900px viewport, button at x=767, 283px popover
  const pos = clampPopoverPos(anchor, 283, 280, 900, 700);
  assert.equal(pos.left, 900 - 283 - 8);
  assert.ok(pos.left + 283 <= 900 - 8, "fully inside horizontally");
});

test("never clips the LEFT edge either (left margin floor)", () => {
  const pos = clampPopoverPos({ left: 2, right: 100, top: 50, bottom: 74 }, 300, 280, 1400, 900);
  assert.equal(pos.left, 8);
});

test("popover wider than the viewport pins to the left margin", () => {
  const pos = clampPopoverPos(anchor, 2000, 280, 900, 700);
  assert.equal(pos.left, 8);
});

test("flips above the anchor when there is no room below", () => {
  // anchor near the bottom of a short viewport
  const pos = clampPopoverPos({ left: 100, right: 200, top: 600, bottom: 624 }, 300, 280, 1400, 700);
  assert.equal(pos.top, 600 - 280 - 5);
  assert.ok(pos.top >= 8);
});

test("even the flip never goes above the top margin", () => {
  // tall popover, anchor mid-screen in a short viewport: flipped position
  // would be negative -> clamped to the gap
  const pos = clampPopoverPos({ left: 100, right: 200, top: 200, bottom: 224 }, 300, 500, 1400, 700);
  assert.ok(pos.top >= 8, `top ${pos.top} >= 8`);
  assert.ok(pos.top + 500 <= 700 - 8 + 5 || pos.top === 8, "inside or pinned");
});
