/**
 * Dockview layouts persist per workspace. One narrow-window moment can
 * squeeze a split group to a couple of pixels, and that poisoned size then
 * restores forever (the "2px phantom group" whose header paints its tabs and
 * buttons over the neighbor). normalizeLayoutSizes walks the serialized grid
 * and clamps every group to a usable minimum, rescaling siblings to keep the
 * parent's budget. Applied at restore time; idempotent for healthy layouts.
 */

export interface LayoutSanitizeOpts {
  minGroupWidth?: number;
  minGroupHeight?: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function normalizeLayoutSizes<T = any>(layout: T, opts: LayoutSanitizeOpts = {}): T {
  const minW = opts.minGroupWidth ?? 120;
  const minH = opts.minGroupHeight ?? 60;
  const grid = (layout as any)?.grid;
  if (!grid?.root || !Array.isArray(grid.root.data)) return layout;

  const walk = (node: any, horizontal: boolean, alloc: number) => {
    if (!node || node.type !== "branch" || !Array.isArray(node.data)) return;
    const kids = node.data;
    const min = horizontal ? minW : minH;
    const visible = kids.filter((k: any) => k?.visible !== false);
    if (visible.length === 0) return;
    const sizes: number[] = visible.map((k: any) => (typeof k.size === "number" && k.size > 0 ? k.size : 0));
    const total = sizes.reduce((a: number, b: number) => a + b, 0);
    const S = total > 0 ? total : alloc;
    if (S > 0) {
      /* water-fill: floor the undersized groups first, then take the deficit
         from the groups still above the floor (proportional to their slack),
         so the floor actually holds instead of being scaled back down. When
         the budget can't afford floors at all, everyone splits equally. */
      const deficit = sizes.reduce((a: number, s: number) => a + Math.max(0, min - s), 0);
      const slack = sizes.reduce((a: number, s: number) => a + Math.max(0, s - min), 0);
      let next: number[];
      if (deficit === 0) {
        next = sizes;
      } else if (slack >= deficit) {
        next = sizes.map((s: number) => (s < min ? min : s - (s - min) * (deficit / slack)));
      } else {
        next = sizes.map(() => S / visible.length);
      }
      visible.forEach((k: any, i: number) => {
        k.size = Math.round(next[i] * 100) / 100;
      });
    }
    /* children of a horizontal branch split vertically, and so on down */
    kids.forEach((k: any) => walk(k, !horizontal, k?.size ?? 0));
  };

  walk(grid.root, grid.orientation === "HORIZONTAL", grid.orientation === "HORIZONTAL" ? grid.width ?? 0 : grid.height ?? 0);
  return layout;
}
