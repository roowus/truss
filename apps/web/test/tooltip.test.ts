import { test } from "node:test";
import assert from "node:assert/strict";
import { TIP_DELAY_MS, TIP_MAX_W, clampTipPos } from "../src/lib/tooltip";

/* the themed card-action tooltip (issue #25): fast hover, bubble centered
   above its button, never clipped by the viewport */

const anchor = { left: 100, right: 128, top: 400, bottom: 428 };

test("the hover delay is fast: ~300ms, well under the native title's", () => {
  assert.ok(TIP_DELAY_MS > 0 && TIP_DELAY_MS <= 400, `delay ${TIP_DELAY_MS}ms should feel immediate`);
  assert.ok(TIP_MAX_W >= 180, "wide enough for a sentence-grade tooltip");
});

test("normal case: centered on the anchor, above it", () => {
  const pos = clampTipPos(anchor, 120, 30, 1400, 900);
  assert.equal(pos.left, 114 - 60, "anchor center (114) minus half the bubble");
  assert.equal(pos.top, 400 - 30 - 6, "6px above the anchor");
});

test("flips below the anchor when there is no room above", () => {
  const pos = clampTipPos({ left: 100, right: 128, top: 20, bottom: 48 }, 120, 30, 1400, 900);
  assert.equal(pos.top, 48 + 6);
});

test("near the right edge the bubble shifts left, never past viewport-8", () => {
  const pos = clampTipPos({ left: 840, right: 868, top: 400, bottom: 428 }, 200, 30, 900, 700);
  assert.equal(pos.left, 900 - 200 - 8);
  assert.ok(pos.left + 200 <= 900 - 8, "fully inside horizontally");
});

test("near the left edge the bubble pins to the left margin", () => {
  const pos = clampTipPos({ left: 2, right: 30, top: 400, bottom: 428 }, 200, 30, 900, 700);
  assert.equal(pos.left, 8);
});

test("a tall bubble in a short viewport still stays inside", () => {
  const pos = clampTipPos({ left: 100, right: 128, top: 20, bottom: 48 }, 120, 300, 1400, 320);
  assert.ok(pos.top >= 8 && pos.top + 300 <= 320 - 8, `top=${pos.top}`);
});
