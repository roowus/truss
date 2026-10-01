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
     size="bar" (pinned at the call sites by the source-scan tests at the
     bottom of this file). */

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

/* ── the filter-bar call sites (issue #11 acceptance criterion 1: every
   dropdown on the two filter bars is the same height as the search box) ──
   Nothing else can observe JSX wiring — this repo has no DOM tests — so the
   two bars are pinned at the source. A Select on either bar without an
   explicit size="bar" falls to the 34px form default and reopens the bug. */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

async function readSource(rel: string): Promise<string> {
  return readFile(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

/** The <Select element containing `marker`, from its opening tag to its self-close. */
function selectAround(source: string, marker: string, label: string): string {
  const at = source.indexOf(marker);
  assert.notEqual(at, -1, `${label}: "${marker}" not found in the panel source`);
  const open = source.lastIndexOf("<Select", at);
  assert.notEqual(open, -1, `${label}: no <Select before "${marker}"`);
  const end = source.indexOf("/>", at);
  assert.notEqual(end, -1, `${label}: the Select at "${marker}" never self-closes`);
  return source.slice(open, end);
}

/** One component's source, from its `header` line to the next top-level function. */
function component(source: string, header: string): string {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `${header} not found`);
  const next = source.indexOf("\nfunction ", start + header.length);
  return source.slice(start, next === -1 ? undefined : next);
}

test("todos filter bar: Group by and the Facet wrapper pass size=\"bar\"", async () => {
  const src = await readSource("../src/panels/TodosPanel.tsx");
  const groupBy = selectAround(src, "ariaLabel=\"Group by\"", "Group by");
  assert.ok(groupBy.includes("size=\"bar\""), "Group by sits beside the search box — it must be the 24px bar size");
  const facet = component(src, "function Facet");
  const facetSelect = selectAround(facet, "Filter by", "Facet");
  assert.ok(facetSelect.includes("size=\"bar\""), "Facet renders the filter-bar dropdowns — without an explicit size they fall to the 34px form default and reopen issue #11");
  const facetUses = src.split("<Facet ").length - 1;
  assert.ok(facetUses >= 4, `Facet should still back the four filter dropdowns (project, agent, folder, label), found ${facetUses}`);
});

test("feed filter bar: every Select in FeedPanel passes size=\"bar\"", async () => {
  const src = await readSource("../src/panels/FeedPanel.tsx");
  const selects = src.split("<Select").length - 1;
  const bar = src.split("<Select size=\"bar\"").length - 1;
  assert.ok(selects >= 2, `FeedPanel should still have its Sort and State dropdowns, found ${selects}`);
  assert.equal(bar, selects, "a FeedPanel Select is missing size=\"bar\" — the form default is 34px and reopens issue #11");
});
