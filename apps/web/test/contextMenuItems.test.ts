import { test } from "node:test";
import assert from "node:assert/strict";
import { tabContextMenuItems } from "../src/lib/contextMenu";

/* Regression tests for the tab context menu's item list (PR #180 review) —
   with only one space the menu ended with an orphaned "separator", invisible
   until separators got their own line color; then it painted as a stray bar
   with padding under it. Separators separate SECTIONS: they may never lead
   or trail the list. */

const noop = () => {};

test("single space: no separator at all — nothing to copy or move to", () => {
  const items = tabContextMenuItems({ others: [], closeOthers: noop, copyTo: noop, moveTo: noop });
  assert.ok(!items.includes("separator"), `trailing separator leaked: ${JSON.stringify(items)}`);
  assert.deepEqual(
    items.map((i) => (typeof i === "string" ? i : i.label)),
    ["close", "Close Others"],
  );
});

test("other spaces: separators sit between sections, never at an edge", () => {
  const others = [
    { id: "s2", name: "Docs" },
    { id: "s3", name: "Scratch" },
  ];
  const items = tabContextMenuItems({ others, copyTo: noop, moveTo: noop });
  const kinds = items.map((i) => (typeof i === "string" ? i : i.label));
  assert.deepEqual(kinds, [
    "close",
    "closeOthers",
    "separator",
    "Copy to Docs",
    "Copy to Scratch",
    "separator",
    "Move to Docs",
    "Move to Scratch",
  ]);
  assert.notEqual(kinds[0], "separator", "never leading");
  assert.notEqual(kinds[kinds.length - 1], "separator", "never trailing");
});

test("copy/move actions fire with the right space id", () => {
  const copied: string[] = [];
  const moved: string[] = [];
  const items = tabContextMenuItems({
    others: [{ id: "s2", name: "Docs" }],
    copyTo: (s) => copied.push(s),
    moveTo: (s) => moved.push(s),
  });
  const pick = (label: string) => {
    const item = items.find((i) => typeof i !== "string" && i.label === label);
    assert.ok(item && typeof item !== "string" && item.action, `${label} carries an action`);
    return (item as { action: () => void }).action;
  };
  pick("Copy to Docs")();
  pick("Move to Docs")();
  assert.deepEqual(copied, ["s2"]);
  assert.deepEqual(moved, ["s2"]);
});

test("a grouped panel gets the custom batch close; a groupless one the builtin", () => {
  const custom = tabContextMenuItems({ others: [], closeOthers: noop, copyTo: noop, moveTo: noop });
  const second = custom[1];
  assert.ok(typeof second !== "string" && second.label === "Close Others");
  const builtin = tabContextMenuItems({ others: [], copyTo: noop, moveTo: noop });
  assert.equal(builtin[1], "closeOthers");
});
