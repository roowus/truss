/**
 * Splitter junctions (issues #148, #187): where a vertical boundary crosses a
 * horizontal one, the crossing is a grabbable vertex. Dragging it moves both
 * boundaries, so the adjacent groups resize together and everything else
 * stays put. A crossing with three or four adjacent panels is a junction: a
 * T (one panel spans both quadrants on its side) drags like a four-way +,
 * except the spanning panel resizes along the crossing axis only.
 *
 * Pure geometry over dockview's serialized grid (`api.toJSON().grid`): no
 * DOM, no dockview imports. The UI overlays a handle per junction, calls
 * dragJunction on pointermove, and applies the resulting sizes to the live
 * groups. Leaf `data` stays opaque here — a panel id in tests, a serialized
 * group in the real dock — so the same math serves both.
 */

export interface LayoutLeaf {
  type: "leaf";
  size?: number;
  visible?: boolean;
  data?: unknown;
}
export interface LayoutBranch {
  type: "branch";
  size?: number;
  visible?: boolean;
  data?: unknown;
}
export type LayoutNode = LayoutLeaf | LayoutBranch;

/** The `grid` half of dockview's SerializedDockview. */
export interface SplitLayout {
  width: number;
  height: number;
  orientation: "HORIZONTAL" | "VERTICAL";
  root: LayoutNode;
}

export interface Junction {
  x: number;
  y: number;
  /** the four adjacent groups, by their leaf data */
  quadrants: { tl: unknown; tr: unknown; bl: unknown; br: unknown };
}

/** A drag never collapses a group below this floor (px). */
export const JUNCTION_MIN_SIZE = 50;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface LeafRect {
  data: unknown;
  rect: Rect;
}

/* A boundary between two visible children of a branch. `path` walks raw
   child indices from the root to the owning branch; `at` is the boundary's
   position among that branch's visible children (between at-1 and at). */
interface VLine {
  x: number;
  y0: number;
  y1: number;
  path: number[];
  at: number;
  leftSize: number;
  rightSize: number;
}
interface HLine {
  y: number;
  x0: number;
  x1: number;
  path: number[];
  at: number;
  upSize: number;
  downSize: number;
}

interface Survey {
  vLines: VLine[];
  hLines: HLine[];
  leaves: LeafRect[];
}

const visibleKids = (branch: LayoutBranch): LayoutNode[] =>
  (Array.isArray(branch.data) ? (branch.data as LayoutNode[]) : []).filter((k) => k && typeof k === "object" && k.visible !== false);

/* Serialized children carry explicit sizes; a hand-built or degenerate tree
   that carries none splits its budget evenly. */
function kidSizes(kids: LayoutNode[], budget: number): number[] {
  const sizes = kids.map((k) => (typeof k.size === "number" && k.size > 0 ? k.size : 0));
  if (kids.length > 0 && sizes.every((s) => s === 0)) return kids.map(() => budget / kids.length);
  return sizes;
}

/** Walk the tree once, recording every boundary line and every leaf's rect. */
function survey(layout: SplitLayout | null | undefined): Survey {
  const out: Survey = { vLines: [], hLines: [], leaves: [] };
  const root = layout?.root;
  if (!root || typeof root !== "object") return out;
  const width = typeof layout?.width === "number" ? layout.width : 0;
  const height = typeof layout?.height === "number" ? layout.height : 0;

  const walk = (node: LayoutNode, rect: Rect, sideBySide: boolean, path: number[]) => {
    if (!node || typeof node !== "object") return;
    if (node.type !== "branch" || !Array.isArray(node.data)) {
      if (node.type === "leaf") out.leaves.push({ data: node.data, rect });
      return;
    }
    const kids = visibleKids(node);
    if (!kids.length) return;
    const sizes = kidSizes(kids, sideBySide ? rect.width : rect.height);
    let offset = sideBySide ? rect.x : rect.y;
    let at = 0;
    (node.data as LayoutNode[]).forEach((kid, rawIndex) => {
      if (!kid || typeof kid !== "object" || kid.visible === false) return;
      const size = sizes[at];
      if (at >= 1) {
        /* boundary between the previous visible child and this one */
        if (sideBySide) {
          out.vLines.push({ x: offset, y0: rect.y, y1: rect.y + rect.height, path, at, leftSize: sizes[at - 1], rightSize: size });
        } else {
          out.hLines.push({ y: offset, x0: rect.x, x1: rect.x + rect.width, path, at, upSize: sizes[at - 1], downSize: size });
        }
      }
      const childRect = sideBySide
        ? { x: offset, y: rect.y, width: size, height: rect.height }
        : { x: rect.x, y: offset, width: rect.width, height: size };
      offset += size;
      walk(kid, childRect, !sideBySide, [...path, rawIndex]);
      at++;
    });
  };

  walk(root, { x: 0, y: 0, width, height }, layout?.orientation !== "VERTICAL", []);
  return out;
}

/* Sample a hair off the crossing so boundary pixels themselves never match. */
const EPS = 0.01;

/**
 * Every crossing of a vertical and a horizontal boundary that has THREE OR
 * FOUR distinct groups around it. Four is the classic +; three is a T, where
 * one panel spans the crossing and covers both quadrants on its side (the
 * quadrant sample names it twice). A true corner, where the boundaries only
 * touch and just two panels meet, is not a junction.
 */
export function splitJunctions(layout: SplitLayout): Junction[] {
  const s = survey(layout);
  if (!s.leaves.length) return [];
  const at = (x: number, y: number) =>
    s.leaves.find((l) => x >= l.rect.x && x < l.rect.x + l.rect.width && y >= l.rect.y && y < l.rect.y + l.rect.height)?.data;
  const seen = new Set<string>();
  const out: Junction[] = [];
  for (const v of s.vLines) {
    for (const h of s.hLines) {
      if (h.y < v.y0 || h.y > v.y1 || v.x < h.x0 || v.x > h.x1) continue;
      const key = `${v.x}:${h.y}`;
      if (seen.has(key)) continue;
      const tl = at(v.x - EPS, h.y - EPS);
      const tr = at(v.x + EPS, h.y - EPS);
      const bl = at(v.x - EPS, h.y + EPS);
      const br = at(v.x + EPS, h.y + EPS);
      if (tl === undefined || tr === undefined || bl === undefined || br === undefined) continue;
      /* Set is SameValueZero: primitives by value, group objects by
         reference — either way a spanning panel shows up as a repeat.
         Three distinct panels means a T (one spans two quadrants); fewer
         than three means a corner, which is no junction. */
      if (new Set([tl, tr, bl, br]).size < 3) continue;
      seen.add(key);
      out.push({ x: v.x, y: h.y, quadrants: { tl, tr, bl, br } });
    }
  }
  return out;
}

/**
 * Move the junction's vertical boundary by dx and its horizontal boundary by
 * dy. The two groups on each side of a moved boundary absorb the delta, so
 * totals conserve; every boundary clamps at JUNCTION_MIN_SIZE per side (all
 * aligned boundaries move in lockstep, by the most restrictive clamp);
 * boundaries not touching the junction stay untouched. Pure: the input is
 * never mutated, and a fully clamped drag returns the SAME layout object.
 */
export function dragJunction(layout: SplitLayout, junction: Junction, dx: number, dy: number): SplitLayout {
  const s = survey(layout);
  if (!s.leaves.length || !junction) return layout;
  const vTargets = s.vLines.filter((v) => v.x === junction.x && junction.y >= v.y0 && junction.y <= v.y1);
  const hTargets = s.hLines.filter((h) => h.y === junction.y && junction.x >= h.x0 && junction.x <= h.x1);
  if (!vTargets.length && !hTargets.length) return layout;

  const clamp = (want: number, lo: number, hi: number) => (lo > hi ? 0 : Math.min(hi, Math.max(lo, want)));
  const ex = vTargets.length
    ? clamp(
        dx,
        Math.max(...vTargets.map((v) => JUNCTION_MIN_SIZE - v.leftSize)),
        Math.min(...vTargets.map((v) => v.rightSize - JUNCTION_MIN_SIZE)),
      )
    : 0;
  const ey = hTargets.length
    ? clamp(
        dy,
        Math.max(...hTargets.map((h) => JUNCTION_MIN_SIZE - h.upSize)),
        Math.min(...hTargets.map((h) => h.downSize - JUNCTION_MIN_SIZE)),
      )
    : 0;
  if (ex === 0 && ey === 0) return layout;

  const next = structuredClone(layout);
  const branchAt = (path: number[]): LayoutBranch => {
    let node = next.root;
    for (const i of path) node = ((node as LayoutBranch).data as LayoutNode[])[i];
    return node as LayoutBranch;
  };
  for (const v of vTargets) {
    const kids = visibleKids(branchAt(v.path));
    kids[v.at - 1].size = v.leftSize + ex;
    kids[v.at].size = v.rightSize - ex;
  }
  for (const h of hTargets) {
    const kids = visibleKids(branchAt(h.path));
    kids[h.at - 1].size = h.upSize + ey;
    kids[h.at].size = h.downSize - ey;
  }
  return next;
}

/** Every leaf's absolute rect — how the UI maps a dragged layout back onto live groups. */
export function layoutLeaves(layout: SplitLayout): LeafRect[] {
  return survey(layout).leaves;
}

/** A serialized group's id, whether the leaf carries a bare id or dockview's group state object. */
export function groupIdOf(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data && typeof data === "object" && typeof (data as { id?: unknown }).id === "string") return (data as { id: string }).id;
  return null;
}

export interface GroupSize {
  id: string;
  width: number;
  height: number;
}

/**
 * Where a junction's handle belongs on screen. The serialized boundary sits
 * at the top-left edge of the inter-group gap (dockview renders the gap
 * trailing each view), so the visual crossing center is half a gap down-right.
 */
export function junctionCenter(junction: Junction, gap = 0): { x: number; y: number } {
  return { x: junction.x + gap / 2, y: junction.y + gap / 2 };
}

/**
 * Groups whose rect changed between two layouts — exactly the setSize calls
 * a junction drag applies to the live dock. Bystanders never appear here.
 */
export function changedGroupSizes(before: SplitLayout, after: SplitLayout): GroupSize[] {
  const prev = new Map<string, Rect>();
  for (const l of layoutLeaves(before)) {
    const id = groupIdOf(l.data);
    if (id) prev.set(id, l.rect);
  }
  const out: GroupSize[] = [];
  for (const l of layoutLeaves(after)) {
    const id = groupIdOf(l.data);
    if (!id) continue;
    const p = prev.get(id);
    if (!p || p.width !== l.rect.width || p.height !== l.rect.height) out.push({ id, width: l.rect.width, height: l.rect.height });
  }
  return out;
}
