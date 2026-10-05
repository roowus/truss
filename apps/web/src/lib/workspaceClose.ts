/**
 * Closing things, Chrome-style (issues #115 and #124). The pure decision
 * core; DesktopStrip.tsx renders the workspace hover X, Workspace.tsx the
 * per-tab X and group-corner X, App.tsx binds the chords, and desktops.ts
 * runs the teardown/restore. Chrome's model, adapted: a window's X closes
 * everything in one gesture, Cmd+Shift+W closes the window, Cmd+Shift+T
 * reopens what you just closed — except Chrome quits on the last window and
 * truss always keeps at least one workspace.
 *
 * The undo stack is ONE mixed LIFO for everything closable (Chrome parity:
 * the chord restores whatever went last, tab or window): ClosedSnapshot for
 * whole workspaces, ClosedPanels for a tab or a whole tab group closed in
 * one gesture. Panels are captured as plain descriptors — the same shape
 * transferPanel re-adds — so a restore needs no live panel objects.
 */

export interface CloseableSpace {
  id: string;
  name?: string;
  layout?: unknown;
}

export interface ClosedSnapshot {
  type: "workspace";
  name: string;
  layout: unknown;
  at: number;
}

/** Everything a restore needs to re-add a closed tab; mirrors transferPanel's addPanel input. */
export interface PanelDescriptor {
  id: string;
  component: string;
  tabComponent: string;
  title: string;
  params?: Record<string, unknown>;
}

/** A tab close, or a whole tab group closed in one gesture (restored as one). */
export interface ClosedPanels {
  type: "panels";
  spaceId: string;
  panels: PanelDescriptor[];
  at: number;
}

/** The mixed undo stack's entry: a closed workspace or closed tab(s). */
export type ClosedEntry = ClosedSnapshot | ClosedPanels;

/** The slice of a dockview panel the descriptor capture reads (structural, so tests stay DOM-free). */
export interface PanelLike {
  id: string;
  title?: string;
  params?: Record<string, unknown>;
  toJSON(): { contentComponent?: string; tabComponent?: string; params?: Record<string, unknown>; title?: string };
}

/** Capture a panel for the undo stack — the same fallbacks transferPanel uses when re-adding. */
export function panelDescriptor(panel: PanelLike): PanelDescriptor {
  const data = panel.toJSON();
  return {
    id: panel.id,
    component: data.contentComponent ?? panel.id.split(":")[0],
    tabComponent: data.tabComponent ?? "truss",
    title: panel.title ?? data.title ?? "",
    params: panel.params ?? data.params,
  };
}

/** The welcome tab closes itself when the first chat opens — machinery, never a user gesture. */
export function isUndoablePanel(id: string): boolean {
  return id !== "welcome";
}

/** Key for the suppression set in desktops.ts — panel ids repeat across workspaces, so the workspace scopes the key. */
export function suppressionKey(spaceId: string, panelId: string): string {
  return `${spaceId}\n${panelId}`;
}

/**
 * Build the undo entry for a close gesture (one tab's X, a group X, "close
 * others"), or null when nothing in it is user-closable — a gesture that
 * closes only machinery (welcome) leaves no phantom undo behind.
 */
export function panelsEntry(spaceId: string, panels: PanelLike[], at: number): ClosedPanels | null {
  const undoable = panels.filter((p) => isUndoablePanel(p.id));
  if (!undoable.length) return null;
  return { type: "panels", spaceId, panels: undoable.map(panelDescriptor), at };
}

/** The palette/chord label for the entry reopenClosed() would restore. */
export function describeClosed(entry: ClosedEntry): string {
  if (entry.type === "workspace") return `Reopen closed workspace: ${entry.name}`;
  if (entry.panels.length === 1) return `Reopen closed tab: ${entry.panels[0].title || entry.panels[0].id}`;
  return `Reopen ${entry.panels.length} closed tabs`;
}

/**
 * Where a tab restore lands: the workspace it closed from when that one is
 * still live and visible (an archived workspace stays hidden — a restore
 * there would be invisible), else the active workspace.
 */
export function restoreSpaceId(entry: ClosedPanels, spaces: { id: string; archived?: boolean }[], activeId: string): string {
  const home = spaces.find((s) => s.id === entry.spaceId);
  return home && !home.archived ? home.id : activeId;
}

/** Drop descriptors whose panel already exists in the target (re-opened by hand since the close). */
export function freshPanels(panels: PanelDescriptor[], exists: (id: string) => boolean): PanelDescriptor[] {
  return panels.filter((p) => !exists(p.id));
}

export interface ChordEvent {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
}

/** Never the last workspace standing; ghosts can't close. */
export function canClose(spaces: CloseableSpace[], id: string): boolean {
  if (spaces.length < 2) return false;
  return spaces.some((s) => s.id === id);
}

/**
 * Chrome's neighbor rule: closing the ACTIVE workspace wakes the one to its
 * LEFT, falling back right when the leftmost goes. Closing a background
 * workspace never yanks focus.
 */
export function nextActiveAfterClose(spaces: CloseableSpace[], closedId: string, activeId: string): string {
  if (closedId !== activeId) return activeId;
  const index = spaces.findIndex((s) => s.id === closedId);
  if (index < 0) return activeId;
  const survivors = spaces.filter((s) => s.id !== closedId);
  if (!survivors.length) return activeId;
  return survivors[Math.max(0, index - 1)].id;
}

const chord = (e: ChordEvent, key: string) =>
  (e.metaKey === true || e.ctrlKey === true) && e.shiftKey === true && e.key.toLowerCase() === key;

/** Cmd/Ctrl+Shift+W closes the active workspace. Plain Cmd+W stays the tab close. */
export const isCloseWindowChord = (e: ChordEvent) => chord(e, "w");

/** Cmd/Ctrl+Shift+T reopens whatever closed last — a tab, a tab group, or a workspace. */
export const isReopenClosedChord = (e: ChordEvent) => chord(e, "t");

/* Sized for the mixed stack: tab closes vastly outnumber workspace closes,
   and Chrome keeps ~25 — a 5-deep cap let six quick tab closes evict a
   workspace close the user still expected to reach (PR #128 audit, B4). */
export const CLOSED_STACK_CAP = 25;

/** Push a close gesture onto the undo stack; the oldest drop off past the cap. */
export function pushClosed<T>(stack: T[], snapshot: T, cap = CLOSED_STACK_CAP): T[] {
  const next = [...stack, snapshot];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** Pop the most recent snapshot (LIFO); empty stack means nothing to reopen. */
export function popClosed<T>(stack: T[]): { snapshot: T; rest: T[] } | null {
  if (!stack.length) return null;
  return { snapshot: stack[stack.length - 1], rest: stack.slice(0, -1) };
}

/**
 * Chrome's tab-X visibility, mapped onto workspace tabs: the ACTIVE workspace
 * pins its X (always visible, like Chrome's active tab), the rest reveal on
 * hover, and an unclosable one (last standing, ghost) gets no X at all so a
 * click there can never close anything.
 */
export function workspaceTabCloseMode(spaces: CloseableSpace[], id: string, activeId: string): "always" | "hover" | null {
  if (!canClose(spaces, id)) return null;
  return id === activeId ? "always" : "hover";
}

/**
 * The shell ids a serialized layout still shows ("terminal:<id>" panels).
 * remove() sweeps these on close so orphaned shells stop; pure so the sweep
 * can be pinned without a dockview instance.
 */
export function terminalIdsInLayout(layout: { panels?: Record<string, unknown> } | null | undefined): string[] {
  return Object.keys(layout?.panels ?? {})
    .filter((p) => p.startsWith("terminal:"))
    .map((p) => p.slice("terminal:".length));
}
