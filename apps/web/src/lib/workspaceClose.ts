/**
 * Closing a whole workspace, Chrome-style (issue #115). The pure decision
 * core; DesktopStrip.tsx renders the hover X, App.tsx binds the chords, and
 * desktops.ts runs the teardown/restore. Chrome's model, adapted: a window's
 * X closes everything in one gesture, Cmd+Shift+W closes the window,
 * Cmd+Shift+T reopens what you just closed — except Chrome quits on the last
 * window and truss always keeps at least one workspace.
 */

export interface CloseableSpace {
  id: string;
  name?: string;
  layout?: unknown;
}

export interface ClosedSnapshot {
  name: string;
  layout: unknown;
  at: number;
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

/** Cmd/Ctrl+Shift+T reopens the last closed workspace with its layout. */
export const isReopenClosedChord = (e: ChordEvent) => chord(e, "t");

export const CLOSED_STACK_CAP = 5;

/** Push a closed workspace onto the undo stack; the oldest drop off past the cap. */
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
 * The shell ids a serialized layout still shows ("terminal:<id>" panels).
 * remove() sweeps these on close so orphaned shells stop; pure so the sweep
 * can be pinned without a dockview instance.
 */
export function terminalIdsInLayout(layout: { panels?: Record<string, unknown> } | null | undefined): string[] {
  return Object.keys(layout?.panels ?? {})
    .filter((p) => p.startsWith("terminal:"))
    .map((p) => p.slice("terminal:".length));
}
