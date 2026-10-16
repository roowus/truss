/**
 * Roving-focus keyboard model for list-like surfaces (issue #227).
 *
 * One place decides what an arrow key does, so menus and the Files tree
 * agree on the standard web behavior instead of each surface hand-rolling
 * its own `Math.min`/`Math.max` clamps. Pure: no DOM, no React — every
 * surface reads the returned index and moves its own highlight.
 *
 * The wrap-vs-clamp split is deliberate and matches the platform:
 *   - menus WRAP (pass `{ wrap: true }`) — arrowing past the last item
 *     lands on the first;
 *   - lists CLAMP (the default) — the Files tree and the `Select` trigger
 *     never jump from the bottom back to the top.
 */

/** No row is focused. `nextIndex` treats this as "entering the list". */
export const NO_FOCUS = -1;

/**
 * The index an arrow/Home/End key moves to, or `current` when the key is
 * not a navigation key (Enter, Escape, typing) — the caller then decides
 * what to do with the event.
 *
 * `current` may be `NO_FOCUS` (-1), which means nothing is focused yet:
 * ArrowDown enters at the top, ArrowUp enters at the bottom. That is what
 * makes "tab into a menu and press Down" work without pre-selecting.
 */
export function nextIndex(current: number, count: number, key: string, opts?: { wrap?: boolean }): number {
  if (count <= 0) return NO_FOCUS;
  const wrap = opts?.wrap === true;
  const last = count - 1;

  /* nothing focused: enter from the direction the user is travelling */
  if (current < 0 || !Number.isFinite(current)) {
    if (key === "ArrowDown") return 0;
    if (key === "ArrowUp") return last;
    if (key === "Home") return 0;
    if (key === "End") return last;
    return NO_FOCUS;
  }

  /* a focused index outside the list (rows vanished under the cursor)
     clamps back into range rather than computing a nonsense step */
  const from = Math.min(Math.trunc(current), last);

  switch (key) {
    case "ArrowDown":
      return from + 1 > last ? (wrap ? 0 : last) : from + 1;
    case "ArrowUp":
      return from - 1 < 0 ? (wrap ? last : 0) : from - 1;
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return from;
  }
}

/** Does this key move the highlight? Lets a call site decide whether to
 *  `preventDefault` without repeating the key list. */
export function isNavKey(key: string): boolean {
  return key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End";
}

/** The keys that open a closed menu trigger: Enter/Space activate it like
 *  a button, the arrows open it and start moving in that direction. */
export function isOpenKey(key: string): boolean {
  return key === "Enter" || key === " " || key === "Spacebar" || key === "ArrowDown" || key === "ArrowUp";
}

/**
 * The standard menu typeahead: the first item starting with `query`,
 * case-insensitive, searching forward from `from` and wrapping past the
 * end back through it (so repeating a letter cycles the matches).
 *
 * `from` is the current row, and searching starts at the row *after* it —
 * which is why pressing "p" twice walks the "P…" items rather than
 * sticking on the first. Returns -1 when nothing matches.
 *
 * This is jump-to-item, not filtering. Surfaces that own a filter box
 * (`Select`) keep filtering; this is for menus with no text input.
 */
export function typeaheadIndex(items: string[], query: string, from = NO_FOCUS): number {
  const q = query.trim().toLowerCase();
  if (!q || items.length === 0) return NO_FOCUS;
  const start = (Number.isFinite(from) ? Math.trunc(from) : NO_FOCUS) + 1;
  for (let step = 0; step < items.length; step++) {
    const i = (((start + step) % items.length) + items.length) % items.length;
    const label = typeof items[i] === "string" ? items[i].trimStart().toLowerCase() : "";
    if (label.startsWith(q)) return i;
  }
  return NO_FOCUS;
}
