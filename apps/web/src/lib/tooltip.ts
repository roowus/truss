/** Themed hover tooltip (issue #25): the feed card actions explain themselves
   on a fast hover instead of the browser's slow, unstyled native title. */

import type { AnchorRect } from "./popover";

/** hover dwell before the bubble shows — fast enough to read as
   self-explaining, slow enough to not flicker when the cursor passes through */
export const TIP_DELAY_MS = 300;

/** the bubble wraps instead of growing past this width */
export const TIP_MAX_W = 220;

/**
 * Place a tooltip against its anchor: centered above it by default, flipped
 * below when there is no room up top, and kept fully inside the viewport.
 * Pure — measured in px against the rendered bubble size after mount (same
 * pattern as clampPopoverPos).
 */
export function clampTipPos(
  anchor: AnchorRect,
  tipW: number,
  tipH: number,
  vw: number,
  vh: number,
  gap = 8,
): { top: number; left: number } {
  let left = anchor.left + (anchor.right - anchor.left) / 2 - tipW / 2;
  if (left + tipW > vw - gap) left = vw - tipW - gap;
  if (left < gap) left = gap;

  let top = anchor.top - tipH - 6;
  if (top < gap) top = anchor.bottom + 6;
  if (top + tipH > vh - gap) top = Math.max(gap, vh - tipH - gap);
  return { top, left };
}
