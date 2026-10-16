import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { clampCursor, shouldTakeTreeFocus, treeKey, type TreeRow } from "../src/lib/fileTreeKeys";

/* Files-tree keyboard navigation (issue #227).
   The tree's rows are a flat array in VISIBLE order: expanded folders are
   inlined, collapsed subtrees are simply absent. That array is the whole
   navigation model, which is also what #226 needs for shift-ranges. */

const rows: TreeRow[] = [
  { path: "README.md", kind: "file" },
  { path: "src", kind: "dir" },
  { path: "src/index.ts", kind: "file" },
  { path: "docs", kind: "dir" },
];

test("ArrowDown/ArrowUp walk the VISIBLE rows and clamp at the ends", () => {
  assert.deepEqual(treeKey(0, rows, {}, "ArrowDown"), { type: "move", index: 1 });
  assert.deepEqual(treeKey(1, rows, {}, "ArrowUp"), { type: "move", index: 0 });
  /* a file list clamps — it never wraps back to the top */
  assert.deepEqual(treeKey(3, rows, {}, "ArrowDown"), { type: "move", index: 3 });
  assert.deepEqual(treeKey(0, rows, {}, "ArrowUp"), { type: "move", index: 0 });
});

test("nothing focused enters at the top going down, the bottom going up", () => {
  assert.deepEqual(treeKey(-1, rows, {}, "ArrowDown"), { type: "move", index: 0 });
  assert.deepEqual(treeKey(-1, rows, {}, "ArrowUp"), { type: "move", index: 3 });
});

test("Home/End jump to the ends of the visible list", () => {
  assert.deepEqual(treeKey(2, rows, {}, "Home"), { type: "move", index: 0 });
  assert.deepEqual(treeKey(0, rows, {}, "End"), { type: "move", index: 3 });
});

test("collapsing a folder removes its children from the visible order", () => {
  /* the collapsed view: `src/index.ts` is no longer reachable by arrows */
  const collapsed = [rows[0], rows[1], rows[3]];
  assert.deepEqual(treeKey(1, collapsed, {}, "ArrowDown"), { type: "move", index: 2 }, "skips the hidden child");
  assert.equal(collapsed.length, 3, "the child is genuinely absent, not merely skipped");
});

test("Left collapses, Right expands, and only for folders", () => {
  assert.deepEqual(treeKey(1, rows, { src: true }, "ArrowLeft"), { type: "collapse", path: "src" });
  assert.deepEqual(treeKey(1, rows, {}, "ArrowRight"), { type: "expand", path: "src" });
  /* already in the target state: a no-op, never a toggle loop */
  assert.deepEqual(treeKey(1, rows, {}, "ArrowLeft"), { type: "none" });
  assert.deepEqual(treeKey(1, rows, { src: true }, "ArrowRight"), { type: "none" });
  /* files do not expand or collapse */
  assert.deepEqual(treeKey(0, rows, {}, "ArrowRight"), { type: "none" });
  assert.deepEqual(treeKey(0, rows, { "README.md": true }, "ArrowLeft"), { type: "none" });
});

test("Enter opens a file for preview and toggles a folder", () => {
  assert.deepEqual(treeKey(0, rows, {}, "Enter"), { type: "open", path: "README.md" });
  assert.deepEqual(treeKey(1, rows, {}, "Enter"), { type: "expand", path: "src" });
});

test("an empty tree and a stale cursor never throw or invent a row", () => {
  assert.deepEqual(treeKey(-1, [], {}, "ArrowDown"), { type: "none" });
  assert.deepEqual(treeKey(-1, [], {}, "Enter"), { type: "none" });
  assert.deepEqual(treeKey(99, rows, {}, "Enter"), { type: "none" }, "past the end: nothing to open");
  assert.deepEqual(treeKey(0, rows, {}, "PageDown"), { type: "none" }, "non-navigation keys are untouched");
});

test("clampCursor keeps the cursor valid when rows vanish", () => {
  assert.equal(clampCursor(3, 3), 2, "last row removed: the cursor moves up");
  assert.equal(clampCursor(0, 0), -1, "empty tree has no cursor");
  assert.equal(clampCursor(-1, 5), -1, "nothing focused stays nothing focused");
  assert.equal(clampCursor(2, 5), 2, "a valid cursor is left alone");
});

/* ---- the tree's focus decision (issue #227) ----------------------------

   The tree focuses itself when the Files panel mounts, because a dockview
   panel has no focusable parent: without it the arrows do nothing until
   the user clicks a row, which is the acceptance criterion the issue sets.
   It must never STEAL focus, so the decision is a pure function and is
   tested here rather than only in a browser. */

test("the tree takes focus when the caret is parked on nothing", () => {
  assert.equal(shouldTakeTreeFocus({ connected: true, containsActive: false, activeTag: "BODY" }), true);
  assert.equal(shouldTakeTreeFocus({ connected: true, containsActive: false, activeTag: "HTML" }), true);
  assert.equal(shouldTakeTreeFocus({ connected: true, containsActive: false, activeTag: null }), true);
  assert.equal(shouldTakeTreeFocus({ connected: true, containsActive: false, activeTag: "body" }), true, "tag case is irrelevant");
});

test("the tree never steals focus from a real control", () => {
  for (const tag of ["INPUT", "TEXTAREA", "BUTTON", "SELECT", "A"]) {
    assert.equal(
      shouldTakeTreeFocus({ connected: true, containsActive: false, activeTag: tag }),
      false,
      `${tag} owns the caret and must keep it`,
    );
  }
});

test("an unmounted or already-focused tree does nothing", () => {
  assert.equal(shouldTakeTreeFocus({ connected: false, containsActive: false, activeTag: "BODY" }), false, "detached container");
  assert.equal(shouldTakeTreeFocus({ connected: true, containsActive: true, activeTag: "DIV" }), false, "already inside the tree");
});

test("read-through: FilesPanel uses the tested helper and ships no ref cleanup", () => {
  const panel = readFileSync(new URL("../src/panels/FilesPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /shouldTakeTreeFocus\(/, "the shipped decision is the tested one");
  /* React 19 runs a function returned from a ref callback as a ref cleanup
     on EVERY re-render, which cancelled the focus retries and left focus on
     <body>. That regression must not come back. */
  const refBody = panel.slice(panel.indexOf("const treeRefCb"), panel.indexOf("const onTreeKeyDown"));
  assert.doesNotMatch(refBody, /return \(\) => \{ cancelAnimationFrame/, "no cleanup return in the focus ref");
  assert.match(refBody, /window\.setTimeout\(grab, 400\)/, "the retries are still scheduled");
  assert.match(panel, /ref=\{treeRefCb\}/, "the callback ref is wired to the container");
});
