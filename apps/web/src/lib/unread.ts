/**
 * Unread-activity model for the sidebar (issue #173). A session row gets a
 * badge when it has activity the user has not seen — separate from the
 * state dot (is the harness busy?) and from the amber permission badge
 * (does it need a click?). All three can show at once.
 *
 * The read marks live client-side in the desktops prefs doc: a map of
 * session id → ms epoch of "you had seen everything up to here". Pure
 * helpers only; the wiring (focus marks the session read, the map persists
 * with the layout) is in desktops.ts and Sidebar.tsx.
 */

/** Marks for a session the app has never seen read anything of. Real
    session metas carry created_at, so "no activity yet" means updated_at
    has not moved past creation. A meta without a creation stamp falls back
    to this floor: activity at or below it reads as the creation blip, not
    news. Real timestamps are epoch ms and always clear it. */
const NO_MARK_FLOOR = 4_000;

/** The map persists with the layout doc, so it must not grow without bound:
    past the cap the stalest marks are dropped — a session whose mark fell
    off simply computes unread from its activity again. */
export const READ_AT_CAP = 500;

export interface UnreadSession {
  id: string;
  updatedAt: number;
  state: string;
  /** session creation, same clock as updatedAt; the "no activity yet"
      baseline for a session with no read mark */
  createdAt?: number;
}

/**
 * Is there activity the user has not seen? Activity strictly after the read
 * mark counts; a session with no mark counts activity past its creation
 * (a fresh session you never opened with nothing new in it is not news).
 * The focused session is never unread — you are looking at it. Run state is
 * deliberately not consulted: a running session can still hold an unseen
 * finished turn.
 */
export function isUnread(session: UnreadSession, readAt: Record<string, number>, focusedId: string | null): boolean {
  if (session.id === focusedId) return false;
  const mark = readAt[session.id];
  if (mark !== undefined) return session.updatedAt > mark;
  return session.updatedAt > (session.createdAt ?? NO_MARK_FLOOR);
}

/**
 * Record "read up to `at`" for a session. Never mutates: always a fresh
 * map. Capped at READ_AT_CAP entries, keeping the freshest marks.
 */
export function markRead(readAt: Record<string, number>, id: string, at: number): Record<string, number> {
  const next: Record<string, number> = { ...readAt, [id]: at };
  const ids = Object.keys(next);
  if (ids.length <= READ_AT_CAP) return next;
  ids.sort((a, b) => (next[b] ?? 0) - (next[a] ?? 0));
  const kept: Record<string, number> = {};
  for (const k of ids.slice(0, READ_AT_CAP)) kept[k] = next[k]!;
  return kept;
}

/**
 * The row's badge model: "unread" when there is something to read, null
 * otherwise. Permission-waiting is a separate badge (the amber count) —
 * both may show; this one only answers "is there unseen activity?".
 */
export function sidebarAttention(session: UnreadSession, readAt: Record<string, number>, focusedId: string | null): "unread" | null {
  return isUnread(session, readAt, focusedId) ? "unread" : null;
}
