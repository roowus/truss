import { useCallback, useEffect, useRef, useState } from "react";
import type { DockviewApi } from "dockview-react";
import {
  changedGroupSizes,
  dragJunction,
  groupIdOf,
  junctionCenter,
  splitJunctions,
  startJunctionDrag,
  type Junction,
  type SplitLayout,
} from "@/lib/splitJunction";

interface Handle {
  key: string;
  x: number;
  y: number;
  junction: Junction;
}

/**
 * Grab handles at splitter junctions (issues #148, #187): where a vertical
 * and a horizontal sash cross, the crossing is a vertex — dragging it moves
 * both boundaries and resizes the adjacent groups together. All geometry is
 * pure (lib/splitJunction.ts) over the serialized grid; this overlay only
 * places handles and pushes the dragged sizes into the live groups.
 */
export function SplitJunctionHandles({ api, gap = 0 }: { api: DockviewApi; gap?: number }) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [handles, setHandles] = useState<Handle[]>([]);
  /* the live gesture's settle function — removes the window listeners and
     ends the session; held in a ref so unmount can tear down mid-drag */
  const endDragRef = useRef<(() => void) | null>(null);

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

  /* unmounting mid-gesture settles the drag too — otherwise the window
     listeners outlive the component and keep resizing a gone dock */
  useEffect(() => () => endDragRef.current?.(), []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>, junction: Junction) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    /* one gesture at a time — a previous one that somehow survived settles
       here instead of stacking listeners */
    endDragRef.current?.();
    /* the drag always diffs against the layout at grab time, so a wiggle
       out and back lands exactly where it started */
    const grid = api.toJSON().grid as SplitLayout;
    const startX = e.clientX;
    const startY = e.clientY;
    const drag = startJunctionDrag(grid, junction, (dx, dy) => {
      const next = dragJunction(grid, junction, dx, dy);
      if (next === grid) return; // clamped shut
      for (const s of changedGroupSizes(grid, next)) {
        api.getGroup(s.id)?.api.setSize({ width: s.width, height: s.height });
      }
    });
    /* move/up ride WINDOW-level listeners attached here and torn down at
       drag end (issue #192). The drag's own setSize calls fire
       onDidLayoutChange → refresh() → the handles re-render mid-drag, and
       with element-level handlers + pointer capture a remounting handle
       killed the release path — the orphaned drag kept following the
       cursor. Window listeners outlive any handle churn; pointercancel and
       window blur settle exactly like pointerup. */
    const onMove = (ev: PointerEvent) => drag.move(ev.clientX - startX, ev.clientY - startY);
    const end = () => {
      if (!drag.active()) return;
      drag.end();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", end);
      if (endDragRef.current === end) endDragRef.current = null;
      /* the last setSize already fired onDidLayoutChange (re-placing the
         handles and persisting via desktops.capture); refresh once more in
         case the final move was a no-op */
      refresh();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", end);
    endDragRef.current = end;
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
          aria-label="Drag to resize the adjacent panels"
          title="Drag to resize the adjacent panels"
          onPointerDown={(e) => onPointerDown(e, h.junction)}
        />
      ))}
    </div>
  );
}
