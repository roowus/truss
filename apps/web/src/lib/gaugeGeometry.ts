/**
 * Ring geometry for a circular gauge drawn inside a square viewBox.
 *
 * An SVG stroke is centered on its path, so a ring of radius r with a
 * stroke width w has its outer edge at r + w/2. Reserving a 1px pad
 * inside the box keeps that edge from being clipped:
 *
 *   r + strokeWidth / 2 + GAUGE_EDGE_PAD <= size / 2
 */

export const GAUGE_EDGE_PAD = 1;

export function gaugeRing({ size, strokeWidth }: { size: number; strokeWidth: number }): {
  r: number;
  cx: number;
  cy: number;
} {
  const half = size / 2;
  // Degenerate inputs (size 0 or negative) collapse to a zero-radius ring
  // instead of a negative one; real sizes always leave the pad.
  const r = Math.max(0, half - strokeWidth / 2 - GAUGE_EDGE_PAD);
  return { r, cx: half, cy: half };
}
