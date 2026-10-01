import { test } from "node:test";
import assert from "node:assert/strict";

/* SPEC-TESTS for filter-bar control alignment — https://github.com/roowus/truss/issues/11
   ("In the todo and feed tabs the dropdowns should be the same height as the
   search bar next to them"). These pin the contract the issue demanded;
   the fix landed with them, so they pass.

   The bug, measured in the source:
   - the filter-bar search box is `h-6` = 24px (Tailwind 4px scale) —
     TodosPanel.tsx:115 and FeedPanel.tsx:74 (identical wrappers);
   - every Select trigger renders with the `t-input` class →
     `height: 34px` (index.css:141, applied at components/ui.tsx:314);
   so the "Group by" / "Sort" / "State" / facet dropdowns stand 10px taller
   than the search box beside them.

   The contract: a single source of truth for control heights —
   src/lib/controls.ts —

     CONTROL_HEIGHTS = { bar: 24, form: 34 }   // px
     selectTriggerHeight(size?: "bar" | "form"): number

   - "bar" is the compact filter-bar row (the search box's h-6 = 24px);
   - "form" is today's default 34px — every existing Select call site
     (dialogs, the add-host wizard, settings…) keeps its look untouched;
   - Select's trigger derives its height from selectTriggerHeight (class or
     inline style — implementation's choice), and the filter bars pass
     size="bar" (acceptance criteria, not pinned here). */

interface ControlsModule {
  CONTROL_HEIGHTS: { bar: number; form: number };
  selectTriggerHeight(size?: "bar" | "form"): number;
}

async function load(): Promise<ControlsModule | null> {
  const spec = "../src/lib/controls"; // variable specifier: typechecks even before the module exists
  return import(spec).catch(() => null);
}

test("src/lib/controls.ts exists with the two control heights", async () => {
  const controls = await load();
  assert.ok(controls, "src/lib/controls.ts must export CONTROL_HEIGHTS + selectTriggerHeight — see issue #11");
  assert.equal(controls.CONTROL_HEIGHTS.bar, 24, "the filter-bar row: h-6 on Tailwind's 4px scale — the search box's height");
  assert.equal(controls.CONTROL_HEIGHTS.form, 34, "today's t-input height (index.css:141)");
});

test("a bar-sized Select trigger is exactly as tall as the search box next to it", async () => {
  const controls = await load();
  assert.ok(controls, "controls module must exist (see constants test)");
  assert.equal(
    controls.selectTriggerHeight("bar"),
    controls.CONTROL_HEIGHTS.bar,
    "the whole point of the issue: dropdown == search bar, to the pixel",
  );
  assert.ok(controls.CONTROL_HEIGHTS.bar < controls.CONTROL_HEIGHTS.form, "bar is the compact variant");
});

test("no size (or \"form\") keeps today's 34px — every existing call site is untouched", async () => {
  const controls = await load();
  assert.ok(controls, "controls module must exist (see constants test)");
  assert.equal(controls.selectTriggerHeight(undefined), 34, "default stays the form size — backward compatible");
  assert.equal(controls.selectTriggerHeight("form"), 34);
});

test("heights are positive integers on the app's 2px rhythm", async () => {
  const controls = await load();
  assert.ok(controls, "controls module must exist (see constants test)");
  for (const size of ["bar", "form"] as const) {
    const h = controls.selectTriggerHeight(size);
    assert.ok(Number.isInteger(h) && h > 0 && h % 2 === 0, `${size}: ${h}px is a sane even height`);
    assert.equal(h, controls.CONTROL_HEIGHTS[size], "the function and the table can never drift apart");
  }
});
