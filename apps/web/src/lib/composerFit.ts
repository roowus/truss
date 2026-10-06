/**
 * Composer resting height and row alignment (issue #139).
 *
 * The bug: the composer textarea autosized with
 * `height = 0; height = min(220, scrollHeight)`. scrollHeight includes the
 * vertical padding, and with content-box sizing that padding is then added
 * AGAIN by the box — so an empty draft rested a row too tall and its
 * placeholder floated a line above the bottom-aligned buttons.
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
 * element collapsed (height 0), so scrollHeight is content + padding; the
 * caller then applies `total - verticalPadding` as the content-box style
 * height, and the box re-adds the padding itself — counted exactly once.
 * Never below one line + padding, never above the cap.
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
