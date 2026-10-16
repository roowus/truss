import { test } from "node:test";
import assert from "node:assert/strict";
import { clampCursor, treeKey, type TreeRow } from "../src/lib/fileTreeKeys";

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
