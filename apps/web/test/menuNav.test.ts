import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isOpenKey, nextIndex, typeaheadIndex } from "../src/lib/listKeys";

/* The app's own popup menus (the workspace ⋯ menu, the running-agents
   menu) had no keyboard handling at all before issue #227. Both drive the
   shared model through src/lib/useMenuCursor.ts; these tests pin the menu
   semantics that hook implements, and the read-through that the menus
   really do go through it rather than growing their own copies. */

const strip = readFileSync(new URL("../src/components/DesktopStrip.tsx", import.meta.url), "utf8");
const chrome = readFileSync(new URL("../src/components/Chrome.tsx", import.meta.url), "utf8");

/* the workspace menu's rows, in render order */
const MENU = ["Rename", "Duplicate layout", "Archive workspace", "Delete workspace"];

test("menus WRAP: arrowing off the last row comes back to the first", () => {
  assert.equal(nextIndex(3, 4, "ArrowDown", { wrap: true }), 0);
  assert.equal(nextIndex(0, 4, "ArrowUp", { wrap: true }), 3);
  assert.equal(nextIndex(-1, 4, "ArrowDown", { wrap: true }), 0, "opening focuses the first row");
  assert.equal(nextIndex(-1, 4, "ArrowUp", { wrap: true }), 3, "…or the last when opened upward");
});

test("Home/End reach the ends of a menu", () => {
  assert.equal(nextIndex(2, 4, "Home", { wrap: true }), 0);
  assert.equal(nextIndex(0, 4, "End", { wrap: true }), 3);
});

test("typeahead jumps to the next row starting with what was typed", () => {
  assert.equal(typeaheadIndex(MENU, "d"), 1, "Duplicate layout, the first D");
  assert.equal(typeaheadIndex(MENU, "de"), 3, "'de' narrows to Delete workspace");
  assert.equal(typeaheadIndex(MENU, "a"), 2);
  assert.equal(typeaheadIndex(MENU, "r"), 0);
  assert.equal(typeaheadIndex(MENU, "zzz"), -1, "no match leaves the highlight alone");
  assert.equal(typeaheadIndex(MENU, ""), -1, "an empty buffer is not a jump");
});

test("typeahead searches from the current row and wraps to reach it", () => {
  assert.equal(typeaheadIndex(MENU, "d", 3), 1, "from the last row it wraps back to Duplicate");
  assert.equal(typeaheadIndex(MENU, "delete", 0), 3);
});

test("a menu opened from the trigger starts at the first row", () => {
  /* opening is Enter/Space/arrows on the trigger; Tab is never hijacked */
  assert.equal(isOpenKey("Enter"), true);
  assert.equal(isOpenKey(" "), true);
  assert.equal(isOpenKey("ArrowDown"), true);
  assert.equal(isOpenKey("ArrowUp"), true);
  assert.equal(isOpenKey("Tab"), false);
  assert.equal(isOpenKey("Escape"), false, "Esc closes, it does not open");
});

test("read-through: both app-owned menus are driven by the shared cursor", () => {
  for (const [name, src] of [["DesktopStrip", strip], ["Chrome", chrome]] as const) {
    assert.match(src, /useMenuCursor/, `${name} uses the shared menu cursor`);
    assert.match(src, /onMenuKeyDown/, `${name} routes key events through it`);
    assert.match(src, /role="menu"/, `${name} exposes a menu role`);
    assert.match(src, /role="menuitem"/, `${name} exposes menu items`);
  }
  /* the ⋯ menu's labels come from one list, so the arrows, the typeahead
     and the rendered rows cannot drift apart */
  assert.match(strip, /menuSpec/, "the workspace menu rows have a single source of truth");
});

test("the ⋯ trigger is a real button with menu semantics", () => {
  assert.match(strip, /aria-haspopup="menu"/, "the trigger advertises a menu");
  assert.match(strip, /aria-expanded=/, "and reports whether it is open");
});

test("regression: a separatorBefore row is DIVIDED, never swallowed", () => {
  /* the ⋯ menu's Delete workspace sits behind a separator. An earlier
     render returned the separator INSTEAD of the row, so Delete vanished
     from a menu that also reports its own label list — the key model knew
     about a row the user could not see or click. */
  assert.match(strip, /separatorBefore && <div/, "the separator renders alongside its row");
  assert.match(strip, /<Fragment key=\{item\.label\}>/, "separator and row share one fragment");
  /* every row in the spec is rendered, including the divider group */
  assert.match(strip, /label: opts\.deleteConfirm \? "Confirm delete" : "Delete workspace"/, "Delete is still a real row");
});

test("regression: opening a menu moves focus into it, not onto the trigger", () => {
  /* focus used to stay on the trigger, so the container's onKeyDown never
     fired and the arrows did nothing at all */
  for (const [name, src] of [["DesktopStrip", strip], ["Chrome", chrome]] as const) {
    assert.match(src, /el\.focus\(\{ preventScroll: true \}\)/, `${name} focuses the menu on open`);
    assert.match(src, /tabIndex=\{-1\}/, `${name} makes the container focusable`);
    assert.doesNotMatch(
      src,
      /ref=\{\(el\) => \{ if \(el\) cursor\.reset\(\); \}\}/,
      `${name} no longer resets without focusing`,
    );
  }
});
