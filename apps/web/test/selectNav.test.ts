import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isArrowKey, isNavKey, isOpenKey, nextIndex } from "../src/lib/listKeys";

/* Select must not regress when its arrow handling moves onto the shared
   model (issue #227). Select is the app's dropdown for long lists (the
   model picker among them) and it already worked from the keyboard; the
   refactor removes two hand-rolled clamp copies, it does not change the
   feel. These tests pin the semantics Select depends on. */

const ui = readFileSync(new URL("../src/components/ui.tsx", import.meta.url), "utf8");

test("Select delegates its index math to the shared model", () => {
  assert.match(ui, /from "@\/lib\/listKeys"/, "ui.tsx imports the shared model");
  assert.match(ui, /nextIndex\(/, "the highlight moves through nextIndex");
  /* the two duplicate clamp copies the issue called out are gone: a clamp
     written as Math.min/Math.max on the highlight index is the smell */
  assert.doesNotMatch(ui, /setHighlight\(\(h\) => Math\.(min|max)\(/, "no hand-rolled highlight clamping left");
});

test("Select CLAMPS rather than wraps — a menu that wraps is a different feel", () => {
  /* these are the moves Select's handlers produce, clamp semantics */
  assert.equal(nextIndex(0, 5, "ArrowUp"), 0, "the top of the list holds");
  assert.equal(nextIndex(4, 5, "ArrowDown"), 4, "and so does the bottom");
  assert.equal(nextIndex(2, 5, "ArrowDown"), 3);
  assert.equal(nextIndex(2, 5, "ArrowUp"), 1);
});

test("Select keeps filter-by-typing: printable characters are not navigation", () => {
  /* `isNavKey` must not swallow letters, or typing would stop filtering */
  for (const ch of ["a", "c", "o", "1", "%"]) assert.equal(isNavKey(ch), false, `"${ch}" is not navigation`);
  assert.equal(nextIndex(2, 5, "c"), 2, "a printable key leaves the highlight alone");
  assert.ok(ui.includes("setFilter((f) => f + e.key)"), "the type-to-filter path is still present");
  assert.ok(ui.includes("filterRef"), "and so is the filter box");
});

test("Select's filter box claims only the arrows — Home/End stay the caret's", () => {
  /* the filter is a real text input: hijacking Home/End would break editing
     the query, so that handler uses the narrower arrow-only set */
  assert.equal(isArrowKey("ArrowDown"), true);
  assert.equal(isArrowKey("ArrowUp"), true);
  assert.equal(isArrowKey("Home"), false, "Home belongs to the text caret here");
  assert.equal(isArrowKey("End"), false, "and so does End");
  assert.equal(isNavKey("Home"), true, "the model still supports them for true lists");
  assert.ok(ui.includes("isArrowKey(e.key)"), "the filter handler uses the arrow-only set");
  assert.ok(!/onFilterKeyDown[\s\S]{0,200}isNavKey\(/.test(ui), "it no longer claims Home/End");
});

test("Select keeps Esc-returns-focus-to-the-trigger and arrow/Enter opening", () => {
  /* Escape closes and hands focus back to the button, not to <body> */
  const escBranch = ui.slice(ui.indexOf('e.key === "Escape"'));
  assert.match(escBranch.slice(0, 220), /setOpen\(false\)/, "Esc closes the dropdown");
  assert.match(escBranch.slice(0, 220), /btnRef\.current\?\.focus\(\)/, "and restores focus to the trigger");
  /* a closed trigger opens on the keys that mean "open a menu" */
  assert.equal(isOpenKey("Enter"), true);
  assert.equal(isOpenKey(" "), true);
  assert.equal(isOpenKey("ArrowDown"), true);
  assert.equal(isOpenKey("ArrowUp"), true);
  assert.equal(isOpenKey("Tab"), false, "Tab is never hijacked");
  assert.equal(isOpenKey("Escape"), false);
});
