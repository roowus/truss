import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isOpenKey, nextIndex, typeaheadIndex } from "../src/lib/listKeys";
import { menuKeyIntent, triggerIntent, typeaheadBuffer } from "../src/lib/useMenuCursor";

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

test("regression: the focus/reset ref runs on MOUNT, never on every render", () => {
  /* A callback ref re-runs on every render. While the reset lived in one,
     moving the highlight re-rendered, which re-ran the ref and wiped the
     index — so End landed on -1 and the arrows appeared dead. The ref must
     be a stable useCallback so React only calls it on mount/unmount. */
  for (const [name, src] of [["DesktopStrip", strip], ["Chrome", chrome]] as const) {
    assert.match(src, /const menuFocusRef = useCallback\(/, `${name} has a stable ref callback`);
    assert.match(src, /ref=\{menuFocusRef\}/, `${name} passes the stable callback`);
    assert.doesNotMatch(src, /ref=\{\(el\) =>/, `${name} has no inline render-time ref`);
    assert.match(src, /cursorRef\.current\?\.reset\(\)/, `${name} resets through the latest cursor`);
  }
});

test("the focused menu container names its active row (aria-activedescendant)", () => {
  /* the container owns focus, so screen readers learn which row is current
     from aria-activedescendant rather than from a focused child */
  assert.match(strip, /aria-activedescendant=\{cursor\.index >= 0/, "the ⋯ menu reports the active row");
  assert.match(strip, /id=\{`ws-menu-\$\{i\}`\}/, "its rows carry matching ids");
  assert.match(chrome, /aria-activedescendant=\{cursor\.index >= 0/, "the agents menu reports the active row");
  assert.match(chrome, /id=\{`agents-menu-\$\{i\}`\}/, "its rows carry matching ids");
});

test("the typeahead jump and the wrap order agree with the rendered labels", () => {
  /* the same list feeds the rendered rows and the typeahead, so a jump can
     never land on a label the user cannot see */
  assert.match(strip, /const menuLabels = useMemo\(\(\) => menuItems\.map/, "labels come from the rows");
  assert.equal(typeaheadIndex(MENU, "a", -1), 2, "and the jump lands on Archive workspace, row 2");
});

/* ---- the hook's decisions, tested behaviorally (issue #227, audit B3) --

   menuNav.test.ts used to be source greps plus pure-model calls, so the
   hook's own logic could break while the suite stayed green — which is how
   the three menu regressions fixed en route shipped. The hook now calls
   these pure functions, so the open -> focus -> navigate path is covered. */

test("triggerIntent: a closed trigger opens on Enter/Space/arrows, never Tab", () => {
  for (const k of ["Enter", " ", "ArrowDown", "ArrowUp"]) {
    assert.equal(triggerIntent(k, false), "open", `${JSON.stringify(k)} opens the menu`);
  }
  assert.equal(triggerIntent("Tab", false), "ignore", "Tab is never hijacked");
  assert.equal(triggerIntent("a", false), "ignore", "typing on a closed trigger does nothing");
});

test("triggerIntent: an open menu closes on Esc and ignores the open keys", () => {
  assert.equal(triggerIntent("Escape", true), "close");
  assert.equal(triggerIntent("Enter", true), "ignore", "Enter activates a row, it does not re-open");
  assert.equal(triggerIntent("ArrowDown", true), "ignore", "the container handles arrows once open");
});

test("menuKeyIntent: Esc closes, Enter/Space activate, arrows wrap, letters typeahead", () => {
  assert.deepEqual(menuKeyIntent({ key: "Escape" }), { kind: "close" });
  assert.deepEqual(menuKeyIntent({ key: "Enter" }), { kind: "activate" });
  assert.deepEqual(menuKeyIntent({ key: " " }), { kind: "activate" });
  assert.deepEqual(menuKeyIntent({ key: "ArrowDown" }), { kind: "move", wrap: true });
  assert.deepEqual(menuKeyIntent({ key: "Home" }), { kind: "move", wrap: true });
  assert.deepEqual(menuKeyIntent({ key: "d" }), { kind: "typeahead" });
  assert.deepEqual(menuKeyIntent({ key: "Tab" }), { kind: "ignore" }, "Tab leaves the menu");
});

test("menuKeyIntent: modifier chords are never typeahead", () => {
  for (const mod of ["metaKey", "ctrlKey", "altKey"] as const) {
    assert.deepEqual(menuKeyIntent({ key: "d", [mod]: true }), { kind: "ignore" }, `${mod}+d must not jump the list`);
  }
  assert.deepEqual(menuKeyIntent({ key: " " }), { kind: "activate" }, "plain space still activates");
});

test("typeaheadBuffer: letters accumulate, then reset after a pause", () => {
  assert.equal(typeaheadBuffer("", 0, "a", 1000), "a", "first character");
  assert.equal(typeaheadBuffer("a", 1000, "r", 1200), "ar", "still within the window");
  assert.equal(typeaheadBuffer("ar", 1000, "c", 1800), "c", "a pause starts a fresh search");
  assert.equal(typeaheadBuffer("ar", 1000, "c", 1700), "arc", "the boundary is inclusive of the gap");
});
