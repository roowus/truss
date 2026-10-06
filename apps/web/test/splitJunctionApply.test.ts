import { test } from "node:test";
import assert from "node:assert/strict";

/* Companion to splitJunction.test.ts (the issue #148 contract): covers the
   helpers the drag overlay uses to map pure geometry back onto live dockview
   groups — layoutLeaves rects, groupIdOf id extraction, and the
   changedGroupSizes diff that decides which setSize calls a drag makes. */

import { changedGroupSizes, groupIdOf, layoutLeaves, splitJunctions, dragJunction } from "../src/lib/splitJunction";

function grid2x2(W = 800, H = 600, a = 500, b = 380) {
  const col = (w: number, topId: string, botId: string) => ({
    type: "branch" as const,
    size: w,
    data: [
      { type: "leaf" as const, size: b, data: topId },
      { type: "leaf" as const, size: H - b, data: botId },
    ],
  });
  return {
    width: W,
    height: H,
    orientation: "HORIZONTAL" as const,
    root: { type: "branch" as const, data: [col(a, "TL", "BL"), col(W - a, "TR", "BR")] },
  };
}

test("layoutLeaves: absolute rects for every leaf, in tree order", () => {
  const leaves = layoutLeaves(grid2x2());
  assert.deepEqual(
    leaves.map((l) => ({ id: l.data, ...l.rect })),
    [
      { id: "TL", x: 0, y: 0, width: 500, height: 380 },
      { id: "BL", x: 0, y: 380, width: 500, height: 220 },
      { id: "TR", x: 500, y: 0, width: 300, height: 380 },
      { id: "BR", x: 500, y: 380, width: 300, height: 220 },
    ],
  );
});

test("groupIdOf: bare ids pass through, dockview group state objects give their id, junk gives null", () => {
  assert.equal(groupIdOf("chat:abc"), "chat:abc");
  assert.equal(groupIdOf({ id: "g7", views: ["chat:abc"], activeView: "chat:abc" }), "g7");
  assert.equal(groupIdOf(null), null);
  assert.equal(groupIdOf(42), null);
  assert.equal(groupIdOf({ views: ["x"] }), null);
});

test("changedGroupSizes: a junction drag touches exactly the four adjacent groups", () => {
  const before = grid2x2();
  const j = splitJunctions(before)[0];
  const after = dragJunction(before, j, 80, -60);
  const changed = changedGroupSizes(before, after);
  assert.deepEqual(
    Object.fromEntries(changed.map((c) => [c.id, [c.width, c.height]])),
    { TL: [580, 320], BL: [580, 280], TR: [220, 320], BR: [220, 280] },
    "left column grew by dx, top row shrank by dy — all four adjacent groups, nobody else",
  );
});

test("changedGroupSizes: dockview-shaped leaves (group state objects) resolve by id; an undragged layout changes nothing", () => {
  const asGroups = (layout: ReturnType<typeof grid2x2>) => JSON.parse(
    JSON.stringify(layout, (k, v) => (k === "data" && typeof v === "string" ? { id: `group-${v}`, views: [v] } : v)),
  );
  const before = asGroups(grid2x2());
  const j = splitJunctions(before)[0];
  assert.ok(j, "group-object leaves still form a junction");
  const changed = changedGroupSizes(before, dragJunction(before, j, 40, 20));
  assert.deepEqual(new Set(changed.map((c) => c.id)), new Set(["group-TL", "group-BL", "group-TR", "group-BR"]));
  assert.deepEqual(changedGroupSizes(before, before), [], "no drag, no setSize calls");
});

test("junctionCenter: the handle sits at the gap's center, half a gap down-right of the boundary", async () => {
  const { junctionCenter } = await import("../src/lib/splitJunction");
  const j = splitJunctions(grid2x2())[0];
  assert.deepEqual([j.x, j.y], [500, 380], "serialized boundary as-is");
  assert.deepEqual(junctionCenter(j, 6), { x: 503, y: 383 }, "dockview's gap trails each view, so the visual crossing is +gap/2 on both axes");
  assert.deepEqual(junctionCenter(j), { x: 500, y: 380 }, "no gap, no offset");
});
