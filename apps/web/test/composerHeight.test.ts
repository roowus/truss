import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* SPEC-TESTS for the composer resting height — https://github.com/roowus/truss/issues/139
   ("Composer rests a row too tall: the 'Message to resume <harness>'
   placeholder sits one row above the buttons even though they don't
   overlap — looks mismatched and ugly"). These FAIL on purpose today: they
   pin the contract a fix must satisfy.

   Today (ChatPanel.tsx): the composer row is `flex items-end … py-1.5` —
   buttons bottom-align — while the textarea autosizes via
   `height=0; height=min(220, scrollHeight)` (content-box: the measure
   double-counts padding, so the empty box rests a row too tall, its
   placeholder floating a line above the buttons).

   The contract: a pure src/lib/composerFit.ts —

     composerTextareaHeight({ scrollHeight, lineHeight, verticalPadding, cap }): number
       Empty draft → EXACTLY one line + vertical padding (never a phantom
       second row — padding is counted once, not twice);
     composerAlign(lineCount): "center" | "end"
       1 line → "center" (placeholder and buttons share the row);
       2+ lines → "end" (buttons sink to the bottom of a tall draft). */

interface ComposerFitModule {
  composerTextareaHeight(input: { scrollHeight: number; lineHeight: number; verticalPadding: number; cap?: number }): number;
  composerAlign(lineCount: number): "center" | "end";
}

async function load(): Promise<ComposerFitModule | null> {
  const spec = "../src/lib/composerFit"; // variable specifier: typechecks before the module exists
  return import(spec).catch(() => null);
}

test("src/lib/composerFit.ts exists", async () => {
  const mod = await load();
  assert.ok(mod, "src/lib/composerFit.ts must export composerTextareaHeight + composerAlign — see issue #139");
});

test("the empty draft is EXACTLY one row — padding counted once", async () => {
  const mod = await load();
  assert.ok(mod, "composerFit module must exist (see module test)");

  const oneLine = 13.5 * 1.5; // 20.25px content
  const pad = 8; // py-1
  /* what the browser reports for an empty rows=1 textarea with py-1 */
  const measured = oneLine + pad;
  const h = mod.composerTextareaHeight({ scrollHeight: measured, lineHeight: oneLine, verticalPadding: pad });
  assert.equal(h, oneLine + pad, "one line + padding, once — the phantom row dies");
  assert.ok(h < oneLine * 2 + pad, "never two rows when empty");

  /* growth is linear and capped */
  const threeLines = mod.composerTextareaHeight({ scrollHeight: oneLine * 3 + pad, lineHeight: oneLine, verticalPadding: pad });
  assert.equal(threeLines, oneLine * 3 + pad, "three lines measure as three");
  const huge = mod.composerTextareaHeight({ scrollHeight: 9000, lineHeight: oneLine, verticalPadding: pad, cap: 220 });
  assert.equal(huge, 220, "the cap holds");
});

test("alignment: single-line centers (placeholder on the buttons' row); multi-line bottoms", async () => {
  const mod = await load();
  assert.ok(mod, "composerFit module must exist (see module test)");

  assert.equal(mod.composerAlign(1), "center", "one line → everything shares the row (the complaint)");
  assert.equal(mod.composerAlign(2), "end", "tall drafts bottom-align the buttons");
  assert.equal(mod.composerAlign(9), "end");
});

test("read-through: the composer actually uses the contract", () => {
  const src = readFileSync(new URL("../src/panels/ChatPanel.tsx", import.meta.url), "utf8");
  assert.ok(/composerAlign\(/.test(src), "the composer row's alignment must come from composerAlign — today it's a static items-end with a mismeasured textarea");
  assert.ok(/composerTextareaHeight\(/.test(src), "the autosize must go through composerTextareaHeight (padding counted once)");
});
