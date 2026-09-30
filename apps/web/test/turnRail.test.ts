import { test } from "node:test";
import assert from "node:assert/strict";

/* SPEC-TESTS for the chat turn rail — https://github.com/roowus/truss/issues/7
   ("DeepSeek Harness's right-side chat length bar in truss"). These FAIL on
   purpose today: they pin the contract a fix must satisfy.

   DSH's TurnNavigator (packages/client/ui-chat/src/client/chat/ in the dsh
   checkout) is a vertical rail docked at the chat's RIGHT edge: one mark per
   turn so the conversation's LENGTH is visible at a glance, hover previews
   the prompt, click jumps to the turn, the active mark tracks scrolling.
   Truss's timeline renders every item (no virtualization), so every mark can
   jump straight to its DOM row — the "unloaded turn pages history" case from
   DSH doesn't exist here.

   The contract: a pure src/lib/turnRail.ts —

   - turnRailItems(items, msgs): one mark per USER message (a turn starts
     where the user speaks), in timeline order; system messages never mark;
     previews are whitespace-collapsed, exclude thinking-channel segments, and
     are bounded to PREVIEW_MAX chars (tooltip-sized).
   - activeRailIndex(tops, scrollY): scroll-spy — the active mark is the last
     one whose row top sits at/above the read line; empty rail → -1.
   - Rail geometry ported from DSH verbatim: marks on a fixed 10px pitch
     (RAIL_ITEM_PITCH) with a 6px inset per end (RAIL_INSET); natural height,
     mark tops, and the inverse pointer→mark mapping with clamping.

   Rendering/docking (absolute right edge of the timeline scroll container,
   fade masks, active-mark styling, click → scrollIntoView) is covered by the
   issue's acceptance criteria, not here. */

interface MsgLike {
  role: string;
  segments: { channel: string; text: string }[];
}
interface ItemLike {
  kind: string;
  id: string;
}
interface RailItem {
  id: string;
  index: number;
  preview: string;
}
interface TurnRailModule {
  RAIL_ITEM_PITCH: number;
  RAIL_INSET: number;
  PREVIEW_MAX: number;
  turnRailItems(items: ItemLike[], msgs: Record<string, MsgLike>): RailItem[];
  activeRailIndex(tops: number[], scrollY: number): number;
  railMarkTop(index: number): number;
  railNaturalHeight(count: number): number;
  railIndexAtOffset(offsetPx: number, count: number): number;
}

async function load(): Promise<TurnRailModule | null> {
  const spec = "../src/lib/turnRail"; // variable specifier: typechecks even before the module exists
  return import(spec).catch(() => null);
}

const msg = (role: string, ...segments: [string, string][]): MsgLike => ({
  role,
  segments: segments.map(([channel, text]) => ({ channel, text })),
});

test("src/lib/turnRail.ts exists with DSH's rail geometry constants", async () => {
  const rail = await load();
  assert.ok(rail, "src/lib/turnRail.ts must exist with the rail geometry + item helpers — see issue #7");
  assert.equal(rail.RAIL_ITEM_PITCH, 10, "DSH's fixed mark pitch (TURN_SPACING_PX)");
  assert.equal(rail.RAIL_INSET, 6, "DSH's per-end rail inset (RAIL_INSET_PX)");
  assert.ok(rail.PREVIEW_MAX >= 40 && rail.PREVIEW_MAX <= 160, "previews are tooltip-sized");
});

test("turnRailItems: one mark per user message, timeline order, clean bounded previews", async () => {
  const rail = await load();
  assert.ok(rail, "turnRail module must exist (see constants test)");

  const items: ItemLike[] = [
    { kind: "msg", id: "u1" },
    { kind: "tool", id: "t1" },
    { kind: "msg", id: "a1" },
    { kind: "perm", id: "p1" },
    { kind: "msg", id: "s1" },
    { kind: "msg", id: "u2" },
    { kind: "msg", id: "u3" },
  ];
  const msgs: Record<string, MsgLike> = {
    u1: msg("user", ["text", "fix   the\nflaky   test"]),
    a1: msg("assistant", ["text", "done"]),
    s1: msg("system", ["text", "cwd vanished"]),
    u2: msg("user", ["text", "now "], ["text", "the linter"]),
    u3: msg("user", ["thinking", "hmm, hidden reasoning"], ["text", "real question"]),
  };

  const marks = rail.turnRailItems(items, msgs);
  assert.deepEqual(marks.map((m) => m.id), ["u1", "u2", "u3"], "user messages only, in order; tools/perms/system never mark");
  assert.deepEqual(marks.map((m) => m.index), [0, 1, 2], "indices are dense and ascending");
  assert.equal(marks[0].preview, "fix the flaky test", "whitespace collapses to single spaces");
  assert.equal(marks[1].preview, "now the linter", "segments concatenate");
  assert.equal(marks[2].preview, "real question", "thinking-channel segments never leak into a preview");
});

test("turnRailItems: previews are bounded; empty chat / no user messages → no marks", async () => {
  const rail = await load();
  assert.ok(rail, "turnRail module must exist (see constants test)");

  assert.deepEqual(rail.turnRailItems([], {}), []);
  const onlyAssistant = [{ kind: "msg", id: "a1" }];
  assert.deepEqual(rail.turnRailItems(onlyAssistant, { a1: msg("assistant", ["text", "hi"]) }), [], "no user message → no rail");

  const long = "x".repeat(500);
  const [mark] = rail.turnRailItems([{ kind: "msg", id: "u" }], { u: msg("user", ["text", long]) });
  assert.ok(mark.preview.length <= rail.PREVIEW_MAX, "a wall of text becomes a tooltip-sized preview");
});

test("activeRailIndex: the active mark is the last row top at/above the read line", async () => {
  const rail = await load();
  assert.ok(rail, "turnRail module must exist (see constants test)");

  const tops = [0, 100, 250];
  assert.equal(rail.activeRailIndex(tops, 0), 0, "top of the chat");
  assert.equal(rail.activeRailIndex(tops, 99), 0, "before the second mark");
  assert.equal(rail.activeRailIndex(tops, 100), 1, "exactly on a mark activates it");
  assert.equal(rail.activeRailIndex(tops, 249), 1);
  assert.equal(rail.activeRailIndex(tops, 9999), 2, "bottom of a long chat: last turn active");
  assert.equal(rail.activeRailIndex([], 0), -1, "empty rail has no active mark");
});

test("railMarkTop / railNaturalHeight: DSH's pitch + inset math", async () => {
  const rail = await load();
  assert.ok(rail, "turnRail module must exist (see constants test)");

  assert.equal(rail.railMarkTop(0), rail.RAIL_INSET, "first mark sits one inset down");
  assert.equal(rail.railMarkTop(3), rail.RAIL_INSET + 3 * rail.RAIL_ITEM_PITCH);
  assert.equal(rail.railNaturalHeight(1), 2 * rail.RAIL_INSET, "one mark: just the two end insets");
  assert.equal(rail.railNaturalHeight(3), (3 - 1) * rail.RAIL_ITEM_PITCH + 2 * rail.RAIL_INSET, "DSH: (count−1)·pitch + 2·inset");
  assert.equal(rail.railNaturalHeight(0), 0, "no marks → no rail");
});

test("railIndexAtOffset: pointer→mark is the inverse mapping, clamped at both ends", async () => {
  const rail = await load();
  assert.ok(rail, "turnRail module must exist (see constants test)");

  const { RAIL_INSET: INSET, RAIL_ITEM_PITCH: PITCH } = rail;
  assert.equal(rail.railIndexAtOffset(INSET, 5), 0, "on the first mark");
  assert.equal(rail.railIndexAtOffset(INSET + 1.4 * PITCH, 5), 1, "rounds to the nearest mark");
  assert.equal(rail.railIndexAtOffset(-50, 5), 0, "above the rail clamps to the first mark");
  assert.equal(rail.railIndexAtOffset(99999, 5), 4, "below the rail clamps to the last mark");
  assert.equal(rail.railIndexAtOffset(INSET, 0), -1, "no marks → nothing to hit");
});
