import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTROL_HEIGHTS, selectTriggerHeight } from "../src/lib/controls";

/* Regression tests for filter-bar control alignment — https://github.com/roowus/truss/issues/11
   ("In the todo and feed tabs the dropdowns should be the same height as the
   search bar next to them").

   The bug, measured in the source:
   - the filter-bar search box is `h-6` = 24px (Tailwind 4px scale) —
     TodosPanel.tsx and FeedPanel.tsx (identical wrappers);
   - every Select trigger carried the `t-input` class → `height: 34px`
     (index.css), so the "Group by" / "Sort" / "State" / facet dropdowns
     stood 10px taller than the search box beside them.

   The fix: one source of truth for control heights — src/lib/controls.ts —

     CONTROL_HEIGHTS = { bar: 24, form: 34 }   // px
     selectTriggerHeight(size?: "bar" | "form"): number

   - "bar" is the compact filter-bar row (the search box's h-6 = 24px);
   - "form" is the default 34px — every existing Select call site (dialogs,
     the add-host wizard, settings…) keeps its look untouched;
   - Select's trigger derives its height from selectTriggerHeight, and the
     filter-bar call sites pass size="bar" — that wiring is pinned in
     filterBarSize.test.ts. */

test("src/lib/controls.ts exists with the two control heights", () => {
  assert.equal(CONTROL_HEIGHTS.bar, 24, "the filter-bar row: h-6 on Tailwind's 4px scale — the search box's height");
  assert.equal(CONTROL_HEIGHTS.form, 34, "today's t-input height (index.css)");
});

test("a bar-sized Select trigger is exactly as tall as the search box next to it", () => {
  assert.equal(
    selectTriggerHeight("bar"),
    CONTROL_HEIGHTS.bar,
    "the whole point of the issue: dropdown == search bar, to the pixel",
  );
  assert.ok(CONTROL_HEIGHTS.bar < CONTROL_HEIGHTS.form, "bar is the compact variant");
});

test("no size (or \"form\") keeps today's 34px — every existing call site is untouched", () => {
  assert.equal(selectTriggerHeight(undefined), 34, "default stays the form size — backward compatible");
  assert.equal(selectTriggerHeight("form"), 34);
});

test("heights are positive integers on the app's 2px rhythm", () => {
  for (const size of ["bar", "form"] as const) {
    const h = selectTriggerHeight(size);
    assert.ok(Number.isInteger(h) && h > 0 && h % 2 === 0, `${size}: ${h}px is a sane even height`);
    assert.equal(h, CONTROL_HEIGHTS[size], "the function and the table can never drift apart");
  }
});
