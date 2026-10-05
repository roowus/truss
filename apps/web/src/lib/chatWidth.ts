/**
 * Draggable chat column width (issue #6), ported from DSH's ConversationRoot:
 * hover the chat's side edge → a handle → drag outward/inward to resize the
 * CENTERED column symmetrically, persisted in localStorage.
 */

export const CHAT_WIDTH_DEFAULT = 760; // today's max-w-[760px] — dragging is opt-in
export const CHAT_WIDTH_MIN = 360;
/* both edge handles must stay grabbable at max width — a dragged width that
   covers its own handle leaves no way to drag back (DSH: 88px/side) */
export const CHAT_WIDTH_EDGE_BUDGET = 176;

/* namespaced like truss.demo.layout — a bare key is collision-prone on a
   shared origin; renamed together with the spec tests per issue #6 */
const KEY = "truss.chat.width";

/**
 * The column's display width: no preference → today's 760 (the CSS max-width
 * caps it at the panel); a preference honored exactly within bounds and
 * display-clamped outside them WITHOUT rewriting the stored pref.
 */
export function resolveChatWidth(columnWidth: number, pref: number | null): number {
  if (pref === null) return CHAT_WIDTH_DEFAULT;
  return Math.max(CHAT_WIDTH_MIN, Math.min(pref, columnWidth - CHAT_WIDTH_EDGE_BUDGET));
}

/** symmetric: the column is centered, so outward travel widens twice; the left handle mirrors */
export function dragChatWidth(base: number, originX: number, currentX: number, side: "left" | "right"): number {
  const travel = side === "right" ? currentX - originX : originX - currentX;
  return base + travel * 2;
}

/**
 * The live drag display: the pointer's request resolved at the current column
 * width, or null when the drag has no effect there — zero travel, or a drag
 * the clamp refuses (outward past the edge budget, inward past the floor).
 * null means "back to the drag-start state": the column must never move
 * against the drag, and a drag that shows nothing must write nothing.
 * `base` is the displayed width the drag started from — dragging from the
 * stored pref instead gives a dead handle once the clamp binds (every drag
 * commits with zero visual change and silently rewrites storage).
 */
export function dragDisplayWidth(
  base: number,
  columnWidth: number,
  originX: number,
  currentX: number,
  side: "left" | "right",
): number | null {
  const w = Math.round(dragChatWidth(base, originX, currentX, side));
  if (w === base) return null;
  const shown = resolveChatWidth(columnWidth, w);
  const moved = w > base ? shown > base : shown < base;
  return moved ? shown : null;
}

/**
 * The drag-commit decision on pointer-up: honored exactly when the live drag
 * display moved (dragDisplayWidth's rule), so what the user saw is what
 * persists. A drag that runs into the clamp — the column is already as wide
 * as the panel's edge budget allows, or as narrow as the floor — persists
 * nothing, exactly like zero travel: a press-and-release doesn't clobber the
 * pref with the clamped value, and a pref the drag can't show (a
 * wide-monitor width under a narrow window) is never silently rewritten.
 */
export function commitChatWidth(
  base: number,
  columnWidth: number,
  originX: number,
  currentX: number,
  side: "left" | "right",
): number | null {
  const w = Math.round(dragChatWidth(base, originX, currentX, side));
  return dragDisplayWidth(base, columnWidth, originX, currentX, side) === null ? null : w;
}

/* the resize handle's placement (issue #116), DSH's model
   (ConversationRoot.module.css): the handle rides the CONTENT column's edge
   and moves with it — pinned to the panel edge it floats ever further from
   the column as the panel widens */
const HANDLE_INSET = 24; // gap from the content edge to the handle's inner edge
const HANDLE_STRIP = 8; // the hit strip's width
const HANDLE_SAFE = 24; // breathing room the strip keeps from the panel edge

/**
 * Where an edge handle sits, from the panel's center: `offset` is the
 * distance to the handle's INNER edge (contentWidth/2 + inset — it moves
 * with the column, never with the panel), `width` the hit strip extending
 * outward from there. DSH's graceful rule: when the margin can't fit
 * inset + strip + safe zone, the strip resolves to zero and `visible` is
 * false — no mispositioned hit area floating over a narrow column.
 * Degenerate inputs (0/negative/NaN) never throw and never NaN out.
 */
export function chatHandleGeometry(panelWidth: number, contentWidth: number): { offset: number; width: number; visible: boolean } {
  const panel = Number.isFinite(panelWidth) && panelWidth > 0 ? panelWidth : 0;
  const content = Number.isFinite(contentWidth) && contentWidth > 0 ? contentWidth : 0;
  const offset = content / 2 + HANDLE_INSET;
  const room = (panel - content) / 2 - HANDLE_INSET - HANDLE_SAFE;
  if (room < HANDLE_STRIP) return { offset, width: 0, visible: false };
  return { offset, width: HANDLE_STRIP, visible: true };
}

/** storage boundary: missing/corrupt → "no preference", never crash, never NaN */
export function readChatWidthPref(storage: { getItem(k: string): string | null }): number | null {
  try {
    const raw = storage.getItem(KEY);
    if (raw == null) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0 || String(n) !== raw.trim()) return null;
    return n;
  } catch {
    return null;
  }
}

export function writeChatWidthPref(storage: { setItem(k: string, v: string): void }, width: number): void {
  try {
    storage.setItem(KEY, String(Math.round(width)));
  } catch {
    /* storage full / blocked — the pref is a nicety, not a requirement */
  }
}
