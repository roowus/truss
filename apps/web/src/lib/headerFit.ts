/**
 * Toolbar overflow planner (issue #3: the chat header's right cluster gets
 * clipped in narrow panels, controls unreachable). Pure + deterministic.
 *
 * planHeaderFit(items, available, { triggerWidth, gap })
 *   items:        in display order (left → right); `essential` never collapses
 *   available:    px the cluster may occupy
 *   triggerWidth: reserved for the overflow trigger ONLY when something
 *                 collapsed into it
 *   → { visible, overflow } both in display order
 *
 * Collapse is rightmost-first among non-essential items; once any item has
 * collapsed, the trigger's footprint counts. The loop stops when the
 * footprint fits or only essentials remain (they may overflow — the caller
 * guarantees they stay reachable by construction).
 */
export interface HeaderFitItem {
  id: string;
  width: number;
  essential?: boolean;
}

export function planHeaderFit(
  items: HeaderFitItem[],
  available: number,
  opts: { triggerWidth: number; gap: number },
): { visible: string[]; overflow: string[] } {
  const { triggerWidth, gap } = opts;
  const visible = items.map((i) => i.id);
  const overflow: string[] = []; // display order maintained by unshift

  const widthOf = (id: string) => items.find((i) => i.id === id)?.width ?? 0;
  const footprint = () => {
    const w = visible.reduce((a, id) => a + widthOf(id), 0) + gap * Math.max(0, visible.length - 1);
    return overflow.length ? w + (visible.length ? gap : 0) + triggerWidth : w;
  };

  for (;;) {
    if (footprint() <= available) break;
    /* rightmost visible, non-essential item collapses next */
    let victim = -1;
    for (let i = visible.length - 1; i >= 0; i--) {
      if (!items.find((it) => it.id === visible[i])?.essential) {
        victim = i;
        break;
      }
    }
    if (victim === -1) break; // only essentials remain — they stay
    overflow.unshift(visible.splice(victim, 1)[0]);
  }
  return { visible, overflow };
}

/* The chat header's right cluster as ChatPanel wires it, in display order.
   `stop` and `more` are essential: the interrupt stays reachable and the ⋯
   menu is the overflow trigger's home. That trigger is rendered on every
   plan, so it is priced here, once — ChatPanel reserves triggerWidth 0.
   Charging it twice (this item plus the trigger reservation) left the
   footprint unchanged when trajectory collapsed, and widths that truly fit
   pushed the model Select into the menu ~28px early.
   apps/web/test/headerFit.test.ts asserts this array still equals its spec
   cluster, so a width that drifts here fails there instead of quietly
   diverging from the rendered header. */
export const HEADER_CLUSTER: HeaderFitItem[] = [
  { id: "select", width: 170 },
  { id: "effort", width: 118 },
  { id: "stop", width: 58, essential: true },
  { id: "trajectory", width: 28 },
  { id: "more", width: 28, essential: true },
];

export const HEADER_GAP = 6;
