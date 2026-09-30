import { test } from "node:test";
import assert from "node:assert/strict";

/* SPEC-TESTS for the tab close button misbehaving during panel resize —
   https://github.com/roowus/truss/issues/21
   ("The X has issues when enlarging and shrinking the window panel").
   These FAIL on purpose today: they pin the contract a fix must satisfy.

   Root cause (current code): the cramped verdict is a hard threshold with no
   hysteresis — isOvercrowded(probes, stripWidth) (lib/tabClose.ts) flips the
   moment natural-widths-plus-chrome crosses the strip width, and
   Workspace.tsx's measure() re-runs it on every ResizeObserver tick. So
   during a continuous sash drag, EVERY tab's X flips mode at the same pixel
   (inline ↔ hover-only overlay; and ultra's <64px check does the same).
   Near the boundary, a 1px wobble toggles the whole strip repeatedly — and
   since issue #8 made the cramped X hover-only, the flip is extra visible:
   the X blinks out of existence mid-resize.

   The contract (amending lib/tabClose.ts): threshold crossings become
   sticky —

     crampedVerdict(prev, naturalPx, stripPx): boolean
       roomy  → cramped once stripPx <= naturalPx            (enter, as today)
       cramped→ roomy only once stripPx >= naturalPx + HYSTERESIS
       between the two edges the PREVIOUS verdict stands (no flip)
     ultraVerdict(prev, tabWidthPx): boolean — same shape around 64px

   with exported TAB_CRAMPED_HYSTERESIS_PX (24–96px band) and
   ULTRA_ENTER_PX / ULTRA_EXIT_PX (exit > enter).

   isOvercrowded stays exported and unchanged in shape for the pure probe
   math; the sticky wrappers own the memory. */

interface TabCloseResizeModule {
  TAB_CRAMPED_HYSTERESIS_PX: number;
  ULTRA_ENTER_PX: number;
  ULTRA_EXIT_PX: number;
  crampedVerdict(prev: boolean, naturalPx: number, stripPx: number): boolean;
  ultraVerdict(prev: boolean, tabWidthPx: number): boolean;
}

async function load(): Promise<TabCloseResizeModule | null> {
  const spec = "../src/lib/tabClose"; // existing module — the new exports are the contract
  const mod: any = await import(spec);
  return typeof mod?.crampedVerdict === "function" && typeof mod?.ultraVerdict === "function" ? mod : null;
}

test("tabClose.ts gains hysteresis constants + sticky verdicts", async () => {
  const mod = await load();
  assert.ok(mod, "tabClose.ts must export crampedVerdict/ultraVerdict + hysteresis constants — see issue #21");
  assert.ok(mod.TAB_CRAMPED_HYSTERESIS_PX >= 24 && mod.TAB_CRAMPED_HYSTERESIS_PX <= 96, "a real deadband, not a epsilon");
  assert.ok(mod.ULTRA_EXIT_PX > mod.ULTRA_ENTER_PX, "ultra exits above where it enters");
});

test("crampedVerdict: enter at the natural edge, exit only past the deadband", async () => {
  const mod = await load();
  assert.ok(mod, "sticky verdicts must exist (see module test)");
  const NAT = 474; // three natural 120px tabs + chrome
  const H = mod.TAB_CRAMPED_HYSTERESIS_PX;

  assert.equal(mod.crampedVerdict(false, NAT, NAT + 200), false, "plenty of room");
  assert.equal(mod.crampedVerdict(false, NAT, NAT), true, "roomy at the edge becomes cramped");
  assert.equal(mod.crampedVerdict(true, NAT, NAT), true, "cramped at the edge stays cramped");
  assert.equal(mod.crampedVerdict(true, NAT, NAT + H - 1), true, "inside the deadband: still cramped");
  assert.equal(mod.crampedVerdict(true, NAT, NAT + H), false, "exit only at the far edge");
  assert.equal(mod.crampedVerdict(false, NAT, NAT + H), false, "roomy never flips upward inside the band");
});

test("the deadband kills measurement flutter: noise at a FIXED sash position never changes the verdict", async () => {
  const mod = await load();
  assert.ok(mod, "sticky verdicts must exist (see module test)");
  const NAT = 474;
  const H = mod.TAB_CRAMPED_HYSTERESIS_PX;
  const w0 = NAT + Math.floor(H / 2); // comfortably inside the band

  /* sub-pixel layout and scrollbar appearance make strip.clientWidth wobble
     ±2px while the user's mouse is still — today's stateless threshold flips
     on every wobble; the sticky verdict must not */
  for (const prev of [false, true]) {
    for (const noise of [-2, -1, 0, 1, 2]) {
      assert.equal(
        mod.crampedVerdict(prev, NAT, w0 + noise),
        prev,
        `prev=${prev} reading=${w0 + noise}: inside the deadband the verdict is the previous verdict`,
      );
    }
  }
});

test("ultraVerdict: same stickiness around the sliver edge", async () => {
  const mod = await load();
  assert.ok(mod, "sticky verdicts must exist (see module test)");
  const { ULTRA_ENTER_PX: ENTER, ULTRA_EXIT_PX: EXIT } = mod;

  assert.equal(mod.ultraVerdict(false, ENTER - 1), true, "shrinking past the edge → ultra");
  assert.equal(mod.ultraVerdict(true, ENTER - 1), true);
  assert.equal(mod.ultraVerdict(true, EXIT - 1), true, "between the edges: stays ultra");
  assert.equal(mod.ultraVerdict(true, EXIT), false, "exits only at the far edge");
  assert.equal(mod.ultraVerdict(false, EXIT), false, "growing past the exit stays roomy");
  assert.equal(mod.ultraVerdict(false, EXIT + 40), false);
});

test("no-width degenerate cases never throw and never flip weirdly", async () => {
  const mod = await load();
  assert.ok(mod, "sticky verdicts must exist (see module test)");
  assert.equal(mod.crampedVerdict(false, 0, 0), false, "hidden strip (0px) reads roomy-ish, corrects on show");
  assert.equal(mod.ultraVerdict(false, 0), true, "a 0px tab is as ultra as it gets");
  assert.equal(mod.crampedVerdict(true, 474, 0), true);
});
