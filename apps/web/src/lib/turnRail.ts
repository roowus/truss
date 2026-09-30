/**
 * The chat turn rail (issue #7), geometry ported from DSH's TurnNavigator:
 * a vertical rail at the chat's right edge, one mark per user turn, hover
 * previews the prompt, click jumps, active mark tracks scrolling.
 */

export const RAIL_ITEM_PITCH = 10; // DSH TURN_SPACING_PX
export const RAIL_INSET = 6; // DSH RAIL_INSET_PX
export const PREVIEW_MAX = 120; // tooltip-sized

export interface RailItem {
  id: string;
  index: number;
  preview: string;
}

interface MsgLike {
  role: string;
  segments: { channel: string; text: string }[];
}
interface ItemLike {
  kind: string;
  id: string;
}

/** one mark per USER message (a turn starts where the user speaks) */
export function turnRailItems(items: ItemLike[], msgs: Record<string, MsgLike>): RailItem[] {
  const out: RailItem[] = [];
  for (const it of items) {
    if (it.kind !== "msg") continue;
    const m = msgs[it.id];
    if (!m || m.role !== "user") continue;
    const preview = m.segments
      .filter((s) => s.channel !== "thinking") // hidden reasoning never leaks
      .map((s) => s.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, PREVIEW_MAX);
    out.push({ id: it.id, index: out.length, preview });
  }
  return out;
}

/** scroll-spy: the active mark is the last row top at/above the read line */
export function activeRailIndex(tops: number[], scrollY: number): number {
  if (tops.length === 0) return -1;
  let idx = 0;
  for (let i = 0; i < tops.length; i++) {
    if (tops[i] <= scrollY) idx = i;
    else break;
  }
  return idx;
}

export function railMarkTop(index: number): number {
  return RAIL_INSET + index * RAIL_ITEM_PITCH;
}

export function railNaturalHeight(count: number): number {
  return count === 0 ? 0 : (count - 1) * RAIL_ITEM_PITCH + 2 * RAIL_INSET;
}

/** pointer offset (px from rail top) → mark index, clamped at both ends */
export function railIndexAtOffset(offsetPx: number, count: number): number {
  if (count <= 0) return -1;
  const i = Math.round((offsetPx - RAIL_INSET) / RAIL_ITEM_PITCH);
  return Math.max(0, Math.min(count - 1, i));
}
