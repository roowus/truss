/** Viewport clamping for anchored popovers (Select dropdowns, menus). */

export interface AnchorRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Keep a popover attached to its anchor and fully inside the viewport:
 * left-aligned to the anchor by default, nudged left when it would run off
 * the right edge, never past the left margin; below the anchor by default,
 * flipped above when there's no room. Pure — measured in px against the
 * actual popover size after mount.
 */
export function clampPopoverPos(
  anchor: AnchorRect,
  popW: number,
  popH: number,
  vw: number,
  vh: number,
  gap = 8,
): { top: number; left: number } {
  let left = anchor.left;
  if (left + popW > vw - gap) left = vw - popW - gap;
  if (left < gap) left = gap;

  let top = anchor.bottom + 5;
  if (top + popH > vh - gap) top = Math.max(gap, anchor.top - popH - 5);
  return { top, left };
}
