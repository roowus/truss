/**
 * Toolbar overflow planner (issue #3: the chat header's right cluster gets
 * clipped in narrow panels, controls unreachable). Pure + deterministic.
 *
 * planHeaderFit(items, available, { triggerWidth, gap })
 *   items:        in display order (left → right); `essential` never collapses
 *   available:    px the cluster may occupy
 *   triggerWidth: reserved for the overflow trigger ONLY when something
 *                 collapsed into it
 *   → { visible, overflow } both in display order, plus `needsMore`:
 *     whether anything collapsed — the ⋯ trigger's render rule (an empty
 *     menu button is dead weight, issue #145)
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
): { visible: string[]; overflow: string[]; needsMore: boolean } {
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
  return { visible, overflow, needsMore: overflow.length > 0 };
}

/* The chat header's right cluster as ChatPanel wires it, in display order.
   The panel shortcuts (context, team, skills) and the agent shell are
   regular members since issue #145 — roomy headers inline them next to
   trajectory, narrow headers collapse them into the ⋯ menu rightmost-first
   (shell first, trajectory last). The model Select left this cluster in
   issue #143 and Stop left in issue #179 — both live in the composer bar
   now, so the header never plans for them (not even as overflow).
   `more` is essential: the ⋯ menu is the overflow trigger's home. That
   trigger is rendered on every
   plan (its menu always carries the utility block — copy reference, resume,
   the id dump — so it is never the empty dead-weight button `needsMore`
   guards against), so it is priced here, once — ChatPanel reserves
   triggerWidth 0. Charging it twice (this item plus the trigger reservation)
   left the footprint unchanged when trajectory collapsed, and widths that
   truly fit pushed an item into the menu ~28px early.
   apps/web/test/headerFit.test.ts asserts this array still equals its spec
   cluster, so a width that drifts here fails there instead of quietly
   diverging from the rendered header. */
export const HEADER_CLUSTER: HeaderFitItem[] = [
  { id: "trajectory", width: 28 },
  { id: "context", width: 28 },
  { id: "team", width: 28 },
  { id: "skills", width: 28 },
  { id: "shell", width: 28 },
  { id: "more", width: 28, essential: true },
];

export const HEADER_GAP = 6;
