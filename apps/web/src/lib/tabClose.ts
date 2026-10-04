/**
 * The tab close button's placement, derived from the Chrome-parity layout
 * (lib/chromeTabs.ts — the decision core; this is only the rendering map).
 * One rule everywhere, so the X never jumps around:
 *
 *   - "inline": in flow, right after the title — only the roomy ACTIVE tab
 *     keeps a pinned X (Chrome's rule; inactive roomy tabs hover-reveal)
 *   - "overlay-right": floating at the tab's right edge, hover-reveal only —
 *     a PINNED X here sat on top of the narrow active tab's truncated title
 *     (issue #8). On hover it covers at most the title's tail, never text
 *     you were reading
 *   - "overlay-icon": ON the favicon — slivers only. Issue #8's
 *     "never over the icon" pin is AMENDED for slivers (issue #95): at
 *     icon-only widths Chrome hides the favicon and puts the X in its place
 *     on hover (the favicon swap). The X still never sits on title TEXT,
 *     and never hangs left of the tab or overhangs a neighbor.
 *
 * null means no X at all (inactive tight tabs, inactive slivers, pinned
 * tabs — a click there must never close anything).
 */
import type { ChromeTabView } from "./chromeTabs";

export type TabClosePlacement = "inline" | "overlay-right" | "overlay-icon";

export function tabClosePlacement(view: ChromeTabView): TabClosePlacement | null {
  if (view.showClose === "never") return null;
  if (view.closeOverIcon) return "overlay-icon";
  return view.showClose === "always" ? "inline" : "overlay-right";
}
