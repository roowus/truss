/**
 * Drag tabs between workspaces (issue #9). Dockview's native drag can't cross
 * its per-workspace instances, so tab payloads ride a dedicated HTML5 MIME —
 * foreign drags (files, text) never arm the workspace chips. Drop handlers
 * see untrusted dataTransfer contents: decode garbage → null, never throws.
 */

export const TAB_DRAG_MIME = "application/x-truss-tab";

export interface TabDragPayload {
  from: string; // source workspace id
  panelId: string;
}

export function encodeTabDrag(payload: TabDragPayload): string {
  return JSON.stringify({ from: payload.from, panelId: payload.panelId });
}

export function decodeTabDrag(raw: string | null | undefined): TabDragPayload | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object") return null;
    if (typeof j.from !== "string" || typeof j.panelId !== "string") return null;
    return { from: j.from, panelId: j.panelId };
  } catch {
    return null;
  }
}

/** dragover gate — only our MIME arms a drop target */
export function isTabDrag(types: readonly string[]): boolean {
  return types.includes(TAB_DRAG_MIME);
}

export type TabDropDecision = { kind: "move"; from: string; to: string; panelId: string } | { kind: "noop" } | null;

/** decode + decide: move across workspaces, no-op back on the source, reject archived/unknown targets */
export function resolveTabDrop(
  raw: string | null | undefined,
  targetSpaceId: string,
  spaces: { id: string; archived?: boolean }[],
): TabDropDecision {
  const payload = decodeTabDrag(raw);
  if (!payload) return null;
  const target = spaces.find((s) => s.id === targetSpaceId);
  if (!target || target.archived) return null;
  if (payload.from === targetSpaceId) return { kind: "noop" }; // dockview owns intra-instance drags
  return { kind: "move", from: payload.from, to: targetSpaceId, panelId: payload.panelId };
}
