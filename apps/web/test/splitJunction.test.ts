import { test } from "node:test";
import assert from "node:assert/strict";

/* SPEC-TESTS for splitter junction dragging — https://github.com/roowus/truss/issues/148
   ("The drag bars between panels are great — but where two of them
   intersect there's a POINT; let me grab that point and drag it, moving
   every panel connected to it — like a vertex in 3D modeling"). These FAIL
   on purpose today: they pin the contract a fix must satisfy.

   Today (dockview splitters): each sash drags its own axis only. Junctions
   (a vertical boundary crossing a horizontal one) are not grabbable.

   The contract: a pure src/lib/splitJunction.ts over dockview's serialized
   layout —

     splitJunctions(layout): Junction[]
       Junction = { x, y, quadrants: { tl, tr, bl, br } }  // the adjacent groups
       — a junction exists where BOTH axes cross with at least three
         distinct panels around the point: a four-quadrant +, or a T where
         one panel spans and covers both quadrants on its side (#187).
         A corner where only two panels meet is no junction;

     dragJunction(layout, junction, dx, dy): layout
       — the vertical boundary moves by dx, the horizontal by dy; the two
         groups on each side absorb the delta (totals conserved); minimum
         sizes clamp (a drag never collapses a panel to 0); nothing
         non-adjacent changes; returns the SAME layout when clamped shut.

   Fixtures below build dockview-shaped trees by hand:
   root branch (HORIZONTAL: children side-by-side) whose children are
   VERTICAL branches (stacked) — a 2×2 grid has exactly one junction. */

/* minimal dockview-serialized shapes */
interface Leaf {
  type: "leaf";
  size: number;
  data: string; // panel id
}
interface Branch {
  type: "branch";
  size?: number;
  data: (Leaf | Branch)[];
}
interface Layout {
  width: number;
  height: number;
  orientation: "HORIZONTAL" | "VERTICAL";
  root: Branch;
}

function grid2x2(W = 800, H = 600, a = 500, b = 380): Layout {
  /* columns: a | W-a ; rows per column: b | H-b */
  const col = (w: number, topId: string, botId: string): Branch => ({
    type: "branch",
    size: w,
    data: [
      { type: "leaf", size: b, data: topId },
      { type: "leaf", size: H - b, data: botId },
    ],
  });
  return {
    width: W,
    height: H,
    orientation: "HORIZONTAL",
    root: { type: "branch", data: [col(a, "TL", "BL"), col(W - a, "TR", "BR")] },
  };
}

/* an L: top row spans the width, bottom row splits — the center crossing
   has no top-left/top-right pair over the bottom split... i.e. only ONE
   quadrant set exists around (a,b): bottom-left present, top-left/right are
   ONE panel → no four-quadrant junction there */
function lShape(W = 800, H = 600, a = 500, b = 380): Layout {
  return {
    width: W,
    height: H,
    orientation: "VERTICAL",
    root: {
      type: "branch",
      data: [
        { type: "leaf", size: b, data: "TOP-SPAN" },
        {
          type: "branch",
          size: H - b,
          data: [
            { type: "leaf", size: a, data: "BL" },
            { type: "leaf", size: W - a, data: "BR" },
          ],
        },
      ],
    },
  };
}

interface Junction {
  x: number;
  y: number;
  quadrants: { tl: string; tr: string; bl: string; br: string };
}
interface SplitJunctionModule {
  splitJunctions(layout: Layout): Junction[];
  dragJunction(layout: Layout, junction: Junction, dx: number, dy: number): Layout;
}

async function load(): Promise<SplitJunctionModule | null> {
  const spec = "../src/lib/splitJunction"; // variable specifier: typechecks before the module exists
  return import(spec).catch(() => null);
}

test("src/lib/splitJunction.ts exists", async () => {
  const mod = await load();
  assert.ok(mod, "src/lib/splitJunction.ts must export splitJunctions + dragJunction — see issue #148");
});

test("a 2×2 grid has exactly one junction at the crossing, naming all four quadrants; an L has none there", async () => {
  const mod = await load();
  assert.ok(mod, "splitJunction module must exist (see module test)");

  const js = mod.splitJunctions(grid2x2());
  assert.equal(js.length, 1, "one crossing");
  assert.deepEqual([js[0].x, js[0].y], [500, 380], "at the boundary crossing");
  assert.deepEqual(js[0].quadrants, { tl: "TL", tr: "TR", bl: "BL", br: "BR" }, "all four neighbors named");

  /* AMENDED (issue #187): T-junctions are junctions — a spanning panel
     covers both quadrants on its side; the crossing still lets you drag
     both axes (the split line moves, the full-width boundary moves). */
  const l = mod.splitJunctions(lShape());
  const tee = l.find((j) => j.x === 500 && j.y === 380);
  assert.ok(tee, "a T-junction IS a junction — the spanning panel's split crossing is grabbable (issue #187)");
  assert.equal(tee.quadrants.tl, "TOP-SPAN", "the spanning panel covers its side");
  assert.equal(tee.quadrants.tr, "TOP-SPAN");
  assert.equal(tee.quadrants.bl, "BL");
  assert.equal(tee.quadrants.br, "BR");
});

test("dragJunction on a T: the split moves with x, the full-width boundary with y — spanning panel resizes vertically only", async () => {
  const mod = await load();
  assert.ok(mod, "splitJunction module must exist (see module test)");

  const before = lShape();
  const j = mod.splitJunctions(before).find((jj) => jj.x === 500 && jj.y === 380)!;
  const after = mod.dragJunction(before, j, 60, -40);

  const [top, bottomBranch] = (after.root as Branch).data as [Leaf, Branch];
  assert.equal(top.size, 340, "the horizontal boundary moved: the spanning panel's height follows dy");
  const [bl, br] = bottomBranch.data as [Leaf, Leaf];
  assert.equal(bl.size, 560, "the split moved with dx");
  assert.equal(br.size, 800 - 560, "its sibling absorbs");
  assert.equal(after.width, 800, "width conserved — the spanning panel's WIDTH is untouched (it spans)");
});

test("dragJunction: both axes move, totals conserve, clamps hold, bystanders untouched", async () => {
  const mod = await load();
  assert.ok(mod, "splitJunction module must exist (see module test)");

  const before = grid2x2();
  const j = mod.splitJunctions(before)[0];
  const after = mod.dragJunction(before, j, 80, -60);

  /* the vertical boundary moved right by 80 → left column grew */
  const leftCol = after.root.data[0] as Branch;
  const rightCol = after.root.data[1] as Branch;
  assert.equal(leftCol.size, 580, "left column absorbs dx");
  assert.equal(rightCol.size, 220, "right column gives it up — width conserved");
  assert.equal(after.width, 800, "total width never changes");

  /* the horizontal boundary moved up by 60 → top rows shrank in BOTH columns */
  for (const col of after.root.data as Branch[]) {
    const [top, bottom] = col.data as Leaf[];
    assert.equal(top.size, 320, "top row absorbs dy in every adjacent column");
    assert.equal(bottom.size, 280);
  }
  assert.equal(after.height, 600, "total height conserved");

  /* the input layout is never mutated */
  assert.equal((before.root.data[0] as Branch).size, 500, "pure — no mutation");

  /* clamps: dragging past the minimum sizes stops at the floor, not through it */
  const slammed = mod.dragJunction(before, j, 99999, 99999);
  const cols = slammed.root.data as Branch[];
  for (const col of cols) for (const leaf of col.data as Leaf[]) assert.ok(leaf.size >= 50, `no panel collapses below the floor (got ${leaf.size})`);
  assert.equal(slammed.width, 800, "clamped drags still conserve");
});

test("a T layout yields exactly its one crossing; a crossing with only two panels around it is still no junction (#187)", async () => {
  const mod = await load();
  assert.ok(mod, "splitJunction module must exist (see module test)");

  assert.equal(mod.splitJunctions(lShape()).length, 1, "the T is one junction, not a scatter of crossings");

  /* the relaxation from four panels to three stops there: when the quadrant
     samples name only TWO panels (each line's sides agree), the crossing is
     a corner and stays ungrabbable */
  const corner = grid2x2();
  const [left, right] = corner.root.data as Branch[];
  (left.data[1] as Leaf).data = "TL"; // bottom-left repeats top-left
  (right.data[1] as Leaf).data = "TR"; // bottom-right repeats top-right
  assert.deepEqual(mod.splitJunctions(corner), [], "two panels meeting at a point is a corner, not a junction");
});

test("degenerate inputs: empty layout → no junctions, no throws", async () => {
  const mod = await load();
  assert.ok(mod, "splitJunction module must exist (see module test)");
  const empty = { width: 0, height: 0, orientation: "HORIZONTAL", root: { type: "branch", data: [] } } as never;
  assert.deepEqual(mod.splitJunctions(empty), []);
  assert.doesNotThrow(() => mod.splitJunctions(null as never));
});
