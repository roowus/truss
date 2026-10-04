/* The pin affordance IS the indicator (issue #99): one element per row, not
   a static glyph next to the title PLUS a hover button in the action row.

     pinned   → solid pin, always visible, click unpins
     unpinned → hollow pin, revealed on hover/focus, click pins

   Rows render exactly this one descriptor, so the two-glyph row can't come
   back. Pin state itself is unchanged — it still comes from the #86 server
   contract; this only decides how a row shows it. */

export interface PinAffordance {
  icon: "pinSolid" | "pin";
  visible: "always" | "hover";
  actionLabel: string;
}

export function pinAffordance(pinned: boolean): PinAffordance {
  return pinned
    ? { icon: "pinSolid", visible: "always", actionLabel: "Unpin from the top of the section" }
    : { icon: "pin", visible: "hover", actionLabel: "Pin to the top of the section" };
}

/* unpinned pins reveal like every other row action — opacity, not display,
   so they stay in the tab order and focus reveals them (issue #86); pinned
   ones never hide. Shared by chat, shell, and host rows. */
export const pinVisibilityCls = (visible: PinAffordance["visible"]) =>
  visible === "hover" ? "opacity-0 group-hover:opacity-70 focus-visible:opacity-100" : "";
