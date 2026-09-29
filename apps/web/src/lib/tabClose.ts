/**
 * The tab close button's ONE source of truth. Chrome's rules, so the X never
 * jumps around:
 *
 * placement — consistent across workspaces, never on the left:
 *   - "inline": in flow, immediately right of the title (roomy tabs)
 *   - "overlay-right": floating at the tab's right edge (squeezed tabs —
 *     the title is truncated, so the edge IS right after the visible title)
 *   - "overlay-center": centered on the tab, 16px — only the ACTIVE ultra
 *     sliver, where it's the tab's only content (a right-anchored 20px X on
 *     a 19px tab overhangs 3px into the LEFT neighbor and misclicks it)
 *   (there used to be a left over-the-icon position, which is what made the
 *   X feel like it teleported between tabs)
 *
 * visibility:
 *   - roomy:        always visible, on every tab
 *   - cramped:      always visible on the ACTIVE tab, hover-reveal on others
 *   - ultra (sliver): the active tab keeps its X; inactive tabs get none
 *     (clicking a sliver must never risk closing it — Chrome's rule)
 */
export function tabCloseBehavior(opts: { cramped: boolean; ultra: boolean; active: boolean }): {
  placement: "inline" | "overlay-right" | "overlay-center";
  visible: "always" | "hover" | "never";
} {
  const { cramped, ultra, active } = opts;
  if (!cramped) return { placement: "inline", visible: "always" };
  if (ultra) return active ? { placement: "overlay-center", visible: "always" } : { placement: "overlay-center", visible: "never" };
  return { placement: "overlay-right", visible: active ? "always" : "hover" };
}

/**
 * Strip-level overcrowding verdict, Chrome-style: crowded ⇔ every tab at its
 * natural (probe-measured, never-compressed) width plus the per-tab chrome
 * (X + gaps + paddings) would overflow the strip. Mode-independent so it
 * can't oscillate when the X flips mode.
 */
export function isOvercrowded(probeWidths: number[], stripWidth: number, perTabChrome = 38): boolean {
  let natural = 0;
  for (const w of probeWidths) natural += w + perTabChrome;
  return natural > stripWidth + 2;
}
