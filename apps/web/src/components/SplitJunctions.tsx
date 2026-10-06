import { useCallback, useEffect, useRef, useState } from "react";
import type { DockviewApi } from "dockview-react";
import {
  changedGroupSizes,
  dragJunction,
  groupIdOf,
  junctionCenter,
  splitJunctions,
  type Junction,
  type SplitLayout,
} from "@/lib/splitJunction";

interface Handle {
  key: string;
  x: number;
  y: number;
  junction: Junction;
}

interface DragState {
  grid: SplitLayout;
  junction: Junction;
  startX: number;
  startY: number;
}

/**
 * Grab handles at splitter junctions (issue #148): where a vertical and a
 * horizontal sash cross, the crossing is a vertex — dragging it moves both
 * boundaries and resizes the four adjacent groups together. All geometry is
 * pure (lib/splitJunction.ts) over the serialized grid; this overlay only
 * places handles and pushes the dragged sizes into the live groups.
 */
export function SplitJunctionHandles({ api, gap = 0 }: { api: DockviewApi; gap?: number }) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [handles, setHandles] = useState<Handle[]>([]);
  const dragRef = useRef<DragState | null>(null);

  const refresh = useCallback(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    try {
      /* a maximized group fills the grid; the crossings are not where the
         serialized sizes say, so the handles sit this state out */
      if (api.hasMaximizedGroup?.()) {
        setHandles((prev) => (prev.length ? [] : prev));
        return;
      }
      const grid = api.toJSON().grid as SplitLayout;
      /* junction coordinates are grid-element pixels; the overlay is a
         sibling of the grid, so measure the offset rather than assume it */
      const gridEl = overlay.parentElement?.querySelector(".dv-grid-view");
      let ox = 0;
      let oy = 0;
      if (gridEl) {
        const g = gridEl.getBoundingClientRect();
        const o = overlay.getBoundingClientRect();
        ox = g.left - o.left;
        oy = g.top - o.top;
      }
      setHandles(
        splitJunctions(grid).map((junction) => {
          /* the serialized boundary is the gap's top-left edge; the handle
             belongs at the gap's center (junctionCenter) */
          const c = junctionCenter(junction, gap);
          return {
            /* keyed by the four quadrant groups, not the position: the key
               survives the drag, so pointer capture never remounts away */
            key: [junction.quadrants.tl, junction.quadrants.tr, junction.quadrants.bl, junction.quadrants.br]
              .map((d) => groupIdOf(d) ?? "?")
              .join("|"),
            x: ox + c.x,
            y: oy + c.y,
            junction,
          };
        }),
      );
    } catch {
      /* toJSON can throw while the dock tears down — the unmount cleanup ends us anyway */
    }
  }, [api, gap]);

  useEffect(() => {
    /* the grid is not laid out at onReady; measure a frame later */
    const raf = requestAnimationFrame(refresh);
    const changed = api.onDidLayoutChange(refresh);
    const maximized = api.onDidMaximizedGroupChange?.(refresh);
    const gridEl = overlayRef.current?.parentElement?.querySelector(".dv-grid-view");
    const ro = new ResizeObserver(refresh);
    if (gridEl) ro.observe(gridEl);
    return () => {
      cancelAnimationFrame(raf);
      changed.dispose();
      maximized?.dispose();
      ro.disconnect();
    };
  }, [api, refresh]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>, junction: Junction) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    /* the drag always diffs against the layout at grab time, so a wiggle
       out and back lands exactly where it started */
    dragRef.current = { grid: api.toJSON().grid as SplitLayout, junction, startX: e.clientX, startY: e.clientY };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const next = dragJunction(drag.grid, drag.junction, e.clientX - drag.startX, e.clientY - drag.startY);
    if (next === drag.grid) return; // clamped shut
    for (const s of changedGroupSizes(drag.grid, next)) {
      api.getGroup(s.id)?.api.setSize({ width: s.width, height: s.height });
    }
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    /* the drag's own setSize calls fire onDidLayoutChange, which both
       re-places the handles and persists the layout via desktops.capture */
    refresh();
  };

  return (
    /* z above dockview's sashes (they sit at z-index 99): inside the
       handle's box the junction wins hover AND press over a highlighted
       sash — hover an edge, drift onto the crossing, and the junction takes
       over as the drag target. Mid-sash-drag the pointer is already spoken
       for, so a drag never switches. */
    <div ref={overlayRef} className="pointer-events-none absolute inset-0 z-[100]">
      {handles.map((h) => (
        <div
          key={h.key}
          className="truss-junction"
          style={{ left: h.x, top: h.y }}
          role="separator"
          aria-label="Drag to resize the four adjacent panels"
          title="Drag to resize the four adjacent panels"
          onPointerDown={(e) => onPointerDown(e, h.junction)}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />
      ))}
    </div>
  );
}
