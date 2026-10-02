import { test } from "node:test";
import assert from "node:assert/strict";

/* SPEC-TESTS for draggable chat width — https://github.com/roowus/truss/issues/6
   ("Adjustable chat column width/padding, like DeepSeek Harness"). These FAIL
   on purpose today: they pin the contract a fix must satisfy.

   Today the chat column is hard-coded: `max-w-[760px] mx-auto px-4`
   (apps/web/src/panels/ChatPanel.tsx:176) — no way to make the text narrower
   or the padding to the panel edge ("the wall") wider.

   The reference implementation is DSH's
   (packages/client/ui-conversation/.../ConversationRoot.tsx in the dsh
   checkout): hover the chat's side edge → a handle → drag outward/inward to
   widen/narrow the CENTERED column symmetrically, persisted in localStorage.
   Its load-bearing details, which this contract ports:

   - resolveChatWidth(columnWidth, pref): with no preference the column is
     exactly today's 760 (zero visual change until the user drags); a
     preference is honored exactly within bounds and display-clamped outside
     them WITHOUT rewriting the stored pref (narrow window → clamped display,
     widen the window → the pref comes back).
   - CHAT_WIDTH_EDGE_BUDGET: the content must leave room at both edges for
     the handles themselves — a dragged width that covers its own handle
     leaves no way to drag back (DSH: 88px/side ⇒ 176).
   - dragChatWidth: symmetric — the column is centered, so outward pointer
     travel widens by TWICE the distance; left and right handles mirror.
   - readChatWidthPref / writeChatWidthPref: storage boundary that treats
     missing or corrupt values as "no preference" (never crash, never NaN).

   Component wiring (hover-revealed edge handles, pointer capture, CSS var
   publication, ResizeObserver re-clamp, composer sharing the axis) is covered
   by the issue's acceptance criteria, not here. */

interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}
interface ChatWidthModule {
  CHAT_WIDTH_MIN: number;
  CHAT_WIDTH_EDGE_BUDGET: number;
  CHAT_WIDTH_DEFAULT: number;
  resolveChatWidth(columnWidth: number, pref: number | null): number;
  dragChatWidth(base: number, originX: number, currentX: number, side: "left" | "right"): number;
  dragDisplayWidth(base: number, columnWidth: number, originX: number, currentX: number, side: "left" | "right"): number | null;
  commitChatWidth(base: number, columnWidth: number, originX: number, currentX: number, side: "left" | "right"): number | null;
  readChatWidthPref(storage: StorageLike): number | null;
  writeChatWidthPref(storage: StorageLike, width: number): void;
}

async function load(): Promise<ChatWidthModule | null> {
  const spec = "../src/lib/chatWidth"; // variable specifier: typechecks even before the module exists
  return import(spec).catch(() => null);
}

function memStorage(initial?: Record<string, string>): StorageLike & { m: Map<string, string> } {
  const m = new Map(Object.entries(initial ?? {}));
  return { m, getItem: (k) => (m.has(k) ? m.get(k)! : null), setItem: (k, v) => void m.set(k, v) };
}

test("src/lib/chatWidth.ts exists with sane constants (default = today's 760px)", async () => {
  const mod = await load();
  assert.ok(mod, "src/lib/chatWidth.ts must exist with the resolve/drag/pref helpers — see issue #6");
  assert.equal(mod.CHAT_WIDTH_DEFAULT, 760, "no-preference width stays exactly today's max-w-[760px] — dragging is opt-in");
  assert.ok(mod.CHAT_WIDTH_MIN >= 320 && mod.CHAT_WIDTH_MIN <= mod.CHAT_WIDTH_DEFAULT, "a usable narrow floor below the default");
  assert.ok(
    mod.CHAT_WIDTH_EDGE_BUDGET >= 176 && mod.CHAT_WIDTH_EDGE_BUDGET <= 400,
    "≥ 2×88px: both edge handles must stay grabbable at max width (DSH's rule), else there's no way to drag back",
  );
});

test("resolveChatWidth: no preference → today's width, regardless of column", async () => {
  const mod = await load();
  assert.ok(mod, "chatWidth module must exist (see constants test)");
  assert.equal(mod.resolveChatWidth(1400, null), 760);
  assert.equal(mod.resolveChatWidth(900, null), 760, "CSS max-width already caps at the panel; the desired width stays 760");
});

test("resolveChatWidth: in-bounds preference honored exactly; out-of-bounds display-clamped", async () => {
  const mod = await load();
  assert.ok(mod, "chatWidth module must exist (see constants test)");
  const { CHAT_WIDTH_MIN: MIN, CHAT_WIDTH_EDGE_BUDGET: EDGE } = mod;

  assert.equal(mod.resolveChatWidth(1400, 820), 820, "in-bounds pref is exact");
  assert.equal(mod.resolveChatWidth(1400, 100), MIN, "too-narrow pref clamps to the floor");
  assert.equal(mod.resolveChatWidth(1400, 9999), 1400 - EDGE, "too-wide pref clamps to the edge budget (handles stay on the column)");
  assert.equal(mod.resolveChatWidth(500, 900), Math.max(MIN, 500 - EDGE), "a column narrower than the floor: never below MIN (DSH formula)");
});

test("dragChatWidth: centered column resizes symmetrically — outward travel counts twice, mirrored per side", async () => {
  const mod = await load();
  assert.ok(mod, "chatWidth module must exist (see constants test)");
  const base = 760;

  assert.equal(mod.dragChatWidth(base, 1000, 1030, "right"), base + 60, "right handle, +30px outward → 60px wider");
  assert.equal(mod.dragChatWidth(base, 1000, 970, "right"), base - 60, "right handle, inward → narrower");
  assert.equal(mod.dragChatWidth(base, 500, 460, "left"), base + 80, "left handle, −40px (outward) → 80px wider");
  assert.equal(mod.dragChatWidth(base, 500, 530, "left"), base - 60, "left handle, inward → narrower");
  assert.equal(mod.dragChatWidth(base, 1000, 1000, "right"), base, "no travel → no change");
});

test("readChatWidthPref: missing/corrupt values resolve to 'no preference', never crash", async () => {
  const mod = await load();
  assert.ok(mod, "chatWidth module must exist (see constants test)");

  assert.equal(mod.readChatWidthPref(memStorage()), null, "unset");
  /* the storage key is namespaced (truss.chat.width), renamed key+tests
     together per issue #6's "change them only together" rule */
  for (const bad of ["abc", "", "-5", "0", "NaN", "Infinity", "12px", "{}"]) {
    assert.equal(mod.readChatWidthPref(memStorage({ "truss.chat.width": bad })), null, `corrupt ${JSON.stringify(bad)} → null`);
  }
  assert.equal(mod.readChatWidthPref(memStorage({ "truss.chat.width": "813" })), 813, "valid positive px reads back");
});

test("writeChatWidthPref round-trips through readChatWidthPref", async () => {
  const mod = await load();
  assert.ok(mod, "chatWidth module must exist (see constants test)");
  const s = memStorage();
  mod.writeChatWidthPref(s, 688);
  assert.equal(mod.readChatWidthPref(s), 688, "drag commit persists and restores");
});

/* audit regression pins (PR #55, round 1 + round 2, B1): the drag-commit
   decision. The drag starts from the DISPLAYED width (resolveChatWidth at the
   current column width) and is honored only when it re-resolves, at the same
   column width, to a width that moved in the dragged direction — otherwise it
   persists nothing and the drag-start state is kept. Round 1 pinned base =
   the stored pref; that deadens the handle once the display clamp binds
   (audit round 2), so these pins replace it. Scenario both rounds trace:
   pref 1200 stored on a wide monitor, chat opened in a 900px panel (display
   clamps to 724 = 900 - 176); a press-and-release must not rewrite 1200. */
test("commitChatWidth: zero travel returns null — a press-and-release persists nothing", async () => {
  const mod = await load();
  assert.ok(mod, "chatWidth module must exist (see constants test)");

  assert.equal(mod.commitChatWidth(724, 900, 1000, 1000, "right"), null, "no travel at a clamped display → no write, the clamped value never reaches storage");
  assert.equal(mod.commitChatWidth(760, 1400, 500, 500, "left"), null, "mirrored on the left handle");
  assert.equal(mod.commitChatWidth(760, 1400, 1000, 1000.2, "right"), null, "sub-pixel travel rounds back to the base → still no write");
  assert.equal(mod.commitChatWidth(mod.CHAT_WIDTH_MIN, 1400, 500, 500, "left"), null, "no travel at the floor → no write");
});

test("commitChatWidth: a drag is honored only when it re-resolves in the dragged direction at the same column width", async () => {
  const mod = await load();
  assert.ok(mod, "chatWidth module must exist (see constants test)");
  const CW = 900;
  const CEIL = CW - mod.CHAT_WIDTH_EDGE_BUDGET; // 724 — the panel's width ceiling
  /* the wiring under test: the drag base is the width the user sees */
  const displayOf = (pref: number | null) => mod.resolveChatWidth(CW, pref);

  /* trace 1: clamped wide-monitor pref 1200 — drags must follow the pointer
     from the clamped display, not from the invisible stored 1200 */
  const clamped = displayOf(1200);
  assert.equal(clamped, CEIL);
  const narrowed = displayOf(mod.commitChatWidth(clamped, CW, 1000, 990, "right"));
  assert.equal(narrowed, CEIL - 20, "an inward drag narrows the column by the dragged amount (was: dead handle, silent pref erosion)");
  /* outward from the ceiling runs into the edge budget: the column cannot
     widen, so the drag shows nothing and must write nothing — the stored
     wide-monitor pref survives */
  assert.equal(mod.commitChatWidth(clamped, CW, 1000, 1010, "right"), null, "a drag the clamp refuses persists nothing");
  assert.equal(displayOf(1200), CEIL, "the refused drag left the stored pref alone");

  /* trace 2: no pref in the same panel — the display is today's 760, already
     past the edge budget, so outward has nowhere to go and must not narrow
     the column to the ceiling */
  const fresh = displayOf(null);
  assert.equal(fresh, 760);
  const narrowedFresh = mod.commitChatWidth(fresh, CW, 1000, 990, "right");
  assert.equal(narrowedFresh, 740, "an inward drag from the default is honored");
  assert.ok(displayOf(narrowedFresh) < fresh, "and the column narrows (760 → the ceiling 724) in the dragged direction; a wider window shows the stored 740");
  assert.equal(mod.commitChatWidth(fresh, CW, 1000, 1010, "right"), null, "outward from the over-budget default persists nothing instead of snapping the column narrower");

  /* an honored drag past the ceiling stores the pointer's request, so a
     wider window honors the intent; the display saturates at the ceiling */
  assert.equal(mod.commitChatWidth(700, CW, 1000, 1030, "right"), 760, "the raw request is stored");
  assert.equal(displayOf(760), CEIL, "and the display saturates at the ceiling at this column width");
});

test("dragDisplayWidth: the live display follows the pointer, never moves against the drag", async () => {
  const mod = await load();
  assert.ok(mod, "chatWidth module must exist (see constants test)");
  const CW = 900;

  assert.equal(mod.dragDisplayWidth(724, CW, 1000, 990, "right"), 704, "inward from a clamped display follows the pointer");
  assert.equal(mod.dragDisplayWidth(724, CW, 1000, 1010, "right"), null, "outward at the ceiling is refused — hold the drag-start state");
  assert.equal(mod.dragDisplayWidth(760, CW, 1000, 1010, "right"), null, "outward from the over-budget no-pref default holds instead of snapping to the ceiling");
  assert.equal(mod.dragDisplayWidth(760, CW, 1000, 990, "right"), 724, "inward from the default follows, saturating at the ceiling (the commit keeps the 740 intent)");
  assert.equal(mod.dragDisplayWidth(mod.CHAT_WIDTH_MIN, 1400, 500, 510, "left"), null, "inward at the floor is refused — hold rather than write a floor-clamped value");
});

/* note: the storage key is the module's own business — tests pass a storage
   boundary in, so no localStorage global is needed and the suite stays
   DOM-free like the rest of apps/web/test. */
