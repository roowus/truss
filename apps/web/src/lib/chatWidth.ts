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

const KEY = "k"; // pinned by the spec tests (chatWidth.test.ts) — the storage boundary key

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
