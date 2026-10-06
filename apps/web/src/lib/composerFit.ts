/**
 * Composer resting height and row alignment (issue #139).
 *
 * The bug: the composer textarea autosized with
 * `height = 0; height = min(220, scrollHeight)` and the row was statically
 * `items-end`, so the placeholder's line floated above the bottom-aligned
 * buttons. (The textarea is border-box under the Tailwind preflight, so
 * scrollHeight's padding was NOT double-counted — the audit of this change
 * confirmed the cascade; the pure contract below is what pins the geometry.)
 *
 * The contract, pure:
 * - composerTextareaHeight: the textarea's TOTAL height (content + padding,
 *   padding counted once) — an empty draft is exactly one line + padding,
 *   growth is linear, the cap holds.
 * - composerAlign: 1 line → "center" (placeholder and buttons share the
 *   row); 2+ lines → "end" (buttons sink to the bottom of a tall draft).
 */

/**
 * The total height the textarea should occupy. The caller measures with the
 * element collapsed (height 0), so scrollHeight is content + padding, and
 * applies the result directly as the (border-box) style height — the
 * padding is counted exactly once. Never below one line + padding, never
 * above the cap.
 */
export function composerTextareaHeight(input: {
  scrollHeight: number;
  lineHeight: number;
  verticalPadding: number;
  cap?: number;
}): number {
  const content = Math.max(input.lineHeight, input.scrollHeight - input.verticalPadding);
  const total = content + input.verticalPadding;
  return input.cap === undefined ? total : Math.min(input.cap, total);
}

/** one line → everything shares the row; a taller draft bottom-aligns the buttons */
export function composerAlign(lineCount: number): "center" | "end" {
  return lineCount <= 1 ? "center" : "end";
}
