/**
 * Uniform tab widths (issue #23), Chrome-flavored: roomy strips give EVERY
 * tab exactly the standard width (a long title and a short one read the
 * same); under overcrowding the ACTIVE tab stays fully displayed while
 * inactives compress UNIFORMLY (never proportionally to title length), above
 * the floor.
 */

export const STANDARD_TAB_WIDTH = 180;
/* == the ultra threshold (ULTRA_ENTER_PX) — past it a tab is a sliver.
   Decision (audit B4): the floor EQUALS the enter threshold, so the ultra
   verdict is unreachable from layoutTabStrip — intentionally: the strip
   scrolls (disableTabsOverflowList) instead of squeezing tabs below the
   floor, so the sliver state can never be entered at runtime. The ultra
   rules stay in tabClose.ts because #21's spec tests pin them; lowering
   this floor instead would break #23's pinned minimum. */
export const MIN_TAB_WIDTH = 64;

export interface TabSpec {
  id: string;
  naturalWidth: number;
  active: boolean;
}

/** crowded ⇔ the tabs can't all have the standard width */
export function isStripOvercrowded(tabs: TabSpec[], stripWidth: number): boolean {
  return tabs.length > 0 && tabs.length * STANDARD_TAB_WIDTH > stripWidth;
}

/**
 * Widths per tab. Roomy: uniform STANDARD. Crowded: the active tab gets
 * min(natural, max(STANDARD, strip − (n−1)·MIN)) — fully displayed whenever
 * the strip can hold it; inactives share the rest equally, floored at MIN
 * unless the minimums alone exceed the strip (then it overflows honestly).
 */
export function layoutTabStrip(input: { stripWidth: number; tabs: TabSpec[] }): { id: string; width: number }[] {
  const { stripWidth, tabs } = input;
  const n = tabs.length;
  if (n === 0) return [];
  if (!isStripOvercrowded(tabs, stripWidth)) {
    return tabs.map((t) => ({ id: t.id, width: STANDARD_TAB_WIDTH }));
  }
  const active = tabs.find((t) => t.active) ?? tabs[0];
  const inactives = tabs.filter((t) => t !== active);
  /* active: full width (capped), but never narrower than the uniform
     inactive share — the focused tab is always the widest one */
  let activeW = Math.min(active.naturalWidth, Math.max(STANDARD_TAB_WIDTH, stripWidth - inactives.length * MIN_TAB_WIDTH));
  const share = inactives.length ? Math.max(MIN_TAB_WIDTH, (stripWidth - activeW) / inactives.length) : 0;
  activeW = Math.max(activeW, share);
  const inactiveW = inactives.length ? Math.max(MIN_TAB_WIDTH, (stripWidth - activeW) / inactives.length) : 0;
  return tabs.map((t) => ({ id: t.id, width: Math.max(1, Math.round((t === active ? activeW : inactiveW) * 100) / 100) }));
}
