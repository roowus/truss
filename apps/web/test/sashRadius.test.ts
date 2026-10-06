import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* SPEC-TESTS for rounded sash highlights — https://github.com/roowus/truss/issues/193
   ("The highlight bars you see while dragging to resize have sharp corners;
   they should be rounded"). These FAIL on purpose today.

   Root cause (traced through dockview's css): dockview themes define
   `--dv-sash-border-radius: 0px` by default (dockview.css:1517 et al.) and
   truss's theme block never overrides it — the amber active-sash highlight
   (the line while dragging) renders with square ends.

   The contract (CSS read-through on index.css):
   - the theme sets --dv-sash-border-radius to a non-zero radius;
   - the radius is small (a hairline pill, 1–4px) — not a blob;
   - the junction dot stays rounded too (it already is — guard). */

const CSS = () => readFileSync(new URL("../src/index.css", import.meta.url), "utf8");

test("the sash highlight is rounded (--dv-sash-border-radius set, non-zero, subtle)", () => {
  const css = CSS();
  const m = css.match(/--dv-sash-border-radius:\s*([^;]+);/);
  assert.ok(m, "index.css must set --dv-sash-border-radius — dockview defaults it to 0px and our amber drag-highlight renders square-ended (issue #193)");
  const px = parseFloat(m![1]);
  assert.ok(px > 0 && px <= 4, `a hairline pill (got ${m![1]}) — the sash is 2–4px wide, so 1–4px of radius rounds it fully`);
});

test("guard: the junction dot keeps its rounding", () => {
  const css = CSS();
  const dot = css.match(/\.truss-junction::before\s*\{[^}]*\}/s);
  assert.ok(dot, "the junction dot rule exists");
  assert.ok(/border-radius:\s*[1-9]/.test(dot![0]), "and stays rounded");
});
