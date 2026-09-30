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
  for (const bad of ["abc", "", "-5", "0", "NaN", "Infinity", "12px", "{}"]) {
    assert.equal(mod.readChatWidthPref(memStorage({ k: bad })), null, `corrupt ${JSON.stringify(bad)} → null`);
  }
  assert.equal(mod.readChatWidthPref(memStorage({ k: "813" })), 813, "valid positive px reads back");
});

test("writeChatWidthPref round-trips through readChatWidthPref", async () => {
  const mod = await load();
  assert.ok(mod, "chatWidth module must exist (see constants test)");
  const s = memStorage();
  mod.writeChatWidthPref(s, 688);
  assert.equal(mod.readChatWidthPref(s), 688, "drag commit persists and restores");
});

/* note: the storage key is the module's own business — tests pass a storage
   boundary in, so no localStorage global is needed and the suite stays
   DOM-free like the rest of apps/web/test. */
