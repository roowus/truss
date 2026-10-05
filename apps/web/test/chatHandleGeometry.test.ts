import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* SPEC-TESTS for the chat-column resize handle placement —
   https://github.com/roowus/truss/issues/116
   ("The resize handle is way too far off to the edge; in DSH it's right on
   the edge of the chat margins and moves with them — make it like that, and
   only show on hover"). These FAIL on purpose today: they pin the contract
   a fix must satisfy.

   Today (ChatPanel.tsx:830-852): the handles are `absolute left-0/right-0`
   strips pinned to the PANEL edges — the wider the panel, the further the
   handle floats from the actual chat column. And the grip has a resting
   `bg-[var(--t-line2)]` — always visible.

   DSH's model (ConversationRoot.module.css:247-253, read): the handle's
   inner edge sits just outside the CONTENT column (`50% + width/2 + inset`),
   so it rides the margin; and when the margin can't fit inset + strip +
   safe zone, the width resolves to ZERO — no mispositioned hit area.

   The contract:

   1. chatWidth.ts gains the geometry:

        chatHandleGeometry(panelWidth: number, contentWidth: number):
          { offset: number; width: number; visible: boolean }

      - offset = the distance from the CENTER to the handle's inner edge:
        contentWidth/2 + inset (inset in a 12..40px band — "right on the
        edge of the chat margins");
      - width = min(strip, room) where room = margin - inset - safeZone —
        clamped: when room can't fit it, width 0 and visible false (never a
        floating hit area);
      - degenerate inputs (0/negative/NaN) never throw, never NaN out.

   2. ChatPanel uses it (read-through pin): the handle's placement comes
      from chatHandleGeometry (no more hard panel-edge `left-0`/`right-0`),
      and the grip is hidden until hover (opacity-0 base, hover reveal). */

interface ChatWidthModule {
  chatHandleGeometry(panelWidth: number, contentWidth: number): { offset: number; width: number; visible: boolean };
}

async function load(): Promise<ChatWidthModule | null> {
  const spec = "../src/lib/chatWidth"; // the module exists; the export is the contract
  const mod: any = await import(spec);
  return typeof mod?.chatHandleGeometry === "function" ? mod : null;
}

const PANEL_SRC = new URL("../src/panels/ChatPanel.tsx", import.meta.url);

test("chatWidth.ts exports chatHandleGeometry", async () => {
  const mod = await load();
  assert.ok(mod, "src/lib/chatWidth.ts must export chatHandleGeometry — see issue #116");
});

test("the geometry rides the content edge, symmetric, clamped to the margin", async () => {
  const mod = await load();
  assert.ok(mod, "chatHandleGeometry must exist (see module test)");

  /* a wide panel: column 760 in 1200 → margin 220 per side; the handle's
     inner edge sits just outside the content edge */
  const wide = mod.chatHandleGeometry(1200, 760);
  assert.ok(wide.visible, "plenty of room → visible");
  assert.ok(wide.offset > 760 / 2, "outside the content edge");
  assert.ok(wide.offset - 760 / 2 >= 12 && wide.offset - 760 / 2 <= 40, `right ON the margin edge (inset ${wide.offset - 380}px), not at the panel edge`);
  assert.ok(wide.width > 0 && wide.width <= 14, "a sane strip width");

  /* same column, wider panel: the handle stays WITH the column (the whole complaint) */
  const wider = mod.chatHandleGeometry(1600, 760);
  assert.equal(wider.offset, wide.offset, "panel grows, handle stays at the margin — never drifts outward");

  /* a tight panel: the margin can't fit inset+strip+safe → zero + hidden */
  const tight = mod.chatHandleGeometry(860, 760);
  assert.equal(tight.visible, false, "no room → no handle (DSH's zero-collapse rule)");
  assert.equal(tight.width, 0, "no ghost hit area");

  /* degenerate inputs never explode */
  for (const [p, c] of [[0, 0], [-100, 50], [100, -50], [NaN, 50]] as const) {
    const g = mod.chatHandleGeometry(p, c);
    assert.ok(Number.isFinite(g.offset) && Number.isFinite(g.width), "never NaN");
    assert.ok(g.width >= 0, "never negative");
  }
});

test("ChatPanel: placement comes from the geometry; the grip is hover-only", () => {
  const src = readFileSync(PANEL_SRC, "utf8");
  assert.ok(/chatHandleGeometry\(/.test(src), "the handle's position must come from chatHandleGeometry — today it's hard-pinned to the panel edge (left-0/right-0)");

  /* the grip: hidden until hover — no resting background rule without an
     opacity gate */
  const grip = src.match(/gripCls\s*=\s*cn\(([^)]*)\)/s);
  assert.ok(grip, "gripCls exists");
  assert.ok(/opacity-0/.test(grip![1]), "the grip is invisible at rest");
  assert.ok(/group-hover\/edge:opacity-/.test(grip![1]), "and reveals on handle hover");
});
