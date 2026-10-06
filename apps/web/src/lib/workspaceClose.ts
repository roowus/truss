/**
 * Closing things, Chrome-style (issues #115 and #124). The pure decision
 * core; DesktopStrip.tsx renders the workspace hover X, Workspace.tsx the
 * per-tab X and group-corner X, App.tsx binds the chords, and desktops.ts
 * runs the teardown/restore. Chrome's model, adapted: a window's X closes
 * everything in one gesture, Cmd+Shift+W closes the window, and a chord
 * reopens what you just closed — except Chrome quits on the last window and
 * truss always keeps at least one workspace. Chrome's own Cmd+Shift+T is
 * browser-reserved (the keydown never reaches a plain tab), so the reopen
 * chord is Cmd/Ctrl+Shift+Z — "undo the close" — with Shift+T kept as a
 * legacy alias for setups that do pass it through. Cmd+Shift+W is just as
 * browser-reserved (Chrome closes its own window — verified in #122), so
 * the advertised close chord is Alt+Shift+W, the strip's Alt+Shift+<letter>
 * pattern (issue #181), with Shift+W kept as its legacy alias.
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

/**
 * Can this entry actually come back? The persisted stack is validated by
 * shape only (parseClosed), so a row from another build — a friendly
 * "tab"/"tab-group" form, or a "panels" row with no panels — must fail here,
 * not deep in a render or a restore (issue #146, audit round 2).
 */
export function canRestore(entry: ClosedEntry): boolean {
  if (entry.type === "workspace") return true;
  const panels = (entry as ClosedPanels).panels;
  return Array.isArray(panels) && panels.length > 0;
}

/** The palette/chord label for the entry reopenClosed() would restore. */
export function describeClosed(entry: ClosedEntry): string {
  if (entry.type === "workspace") return `Reopen closed workspace: ${entry.name}`;
  if (!canRestore(entry)) return "Closed item (not restorable)";
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
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
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

/* The strip's own pattern (Alt+Shift+T adds a tab): exactly Alt+Shift, no
   Cmd/Ctrl — extra modifiers mean some other gesture. Matches on the
   physical code as well as the letter: on macOS Option is a composer, so
   Option+Shift+W reports a composed glyph as e.key („ on US layouts) and a
   letter-only match would be dead there — e.code ("KeyW") is
   layout/composer-independent (PR #184 audit, B1). */
const altChord = (e: ChordEvent, key: string, code: string) =>
  e.altKey === true &&
  e.shiftKey === true &&
  e.metaKey !== true &&
  e.ctrlKey !== true &&
  (e.key.toLowerCase() === key || e.code === code);

/**
 * Alt+Shift+W closes the active workspace — the chord browsers actually
 * deliver: Chrome reserves Cmd/Ctrl+Shift+W for its own window close and the
 * keydown never reaches a plain tab (verified in #122), so Shift+W is dead
 * there. It stays as a legacy alias for keyboard-lock/embedded setups that
 * pass it through, where it keeps Chrome's window-level semantics (fires
 * mid-typing). The advertised Alt+Shift chord follows the strip pattern and,
 * like Alt+Shift+T, yields while typing. Plain Cmd+W stays the tab close.
 */
export const isCloseWindowChord = (e: ChordEvent, typing = false) => chord(e, "w") || (altChord(e, "w", "KeyW") && !typing);

/**
 * Cmd/Ctrl+Shift+Z reopens whatever closed last — a tab, a tab group, or a
 * workspace. Chrome reserves Cmd/Ctrl+Shift+T for itself (the keydown never
 * reaches a plain browser tab — the #120 audit's B1, confirmed by hand), so
 * the advertised chord is Shift+Z: "undo the close". It is a text-redo chord,
 * so it must NOT fire while typing (inputs and terminals keep their redo);
 * Shift+T stays as a legacy alias for environments that pass it through.
 */
export const isReopenClosedChord = (e: ChordEvent, typing = false) => chord(e, "t") || (chord(e, "z") && !typing);

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

/* The PERSISTED undo stack (issue #146) is smaller than the live one: reload
   insurance, not a second archive. Ten deep covers "I closed the wrong
   workspace and restarted" without growing the layout doc forever. */
export const CLOSED_PERSIST_CAP = 10;

/** A row survives the round-trip when it has a type tag and a timestamp; the
    restore path drops types it cannot handle, so unknown rows never wedge it. */
function closedRowOk(e: unknown): e is ClosedEntry {
  if (!e || typeof e !== "object") return false;
  const row = e as { type?: unknown; at?: unknown };
  return typeof row.type === "string" && typeof row.at === "number" && Number.isFinite(row.at);
}

/** Serialize the undo stack for the layout doc: valid rows only, newest CLOSED_PERSIST_CAP kept. */
export function serializeClosed(stack: readonly unknown[] | null | undefined): string {
  const list = Array.isArray(stack) ? stack.filter(closedRowOk).slice(-CLOSED_PERSIST_CAP) : [];
  return JSON.stringify(list);
}

/** Read a persisted undo stack back: garbage in, empty stack out — never a crash. */
export function parseClosed(raw: unknown): ClosedEntry[] {
  if (typeof raw !== "string") return [];
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.filter(closedRowOk).slice(-CLOSED_PERSIST_CAP);
  } catch {
    return [];
  }
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
