/**
 * The unified Trash listing (issue #146): deleted chats from the 30-day
 * trash (server-side, deleted_at stamped) and closed workspaces/tab
 * groups/tabs from the close-undo stack (#115, persisted by desktops.ts),
 * merged into one newest-first list for TrashPanel. Pure, so the panel and
 * the tests share the exact same math.
 *
 * Every entry carries a restoreId: a session id for chats (the restore
 * route), the undo-stack index as a string for closed entries
 * (desktops.reopenClosedAt). Unknown or malformed rows drop out silently —
 * a trash listing must never crash on data it half-recognizes.
 */

import { daysLeftInTrash } from "./format";

export type TrashKind = "session" | "workspace" | "tab-group" | "tab";

export interface TrashEntry {
  kind: TrashKind;
  id: string;
  title: string;
  deletedAt: number;
  /** chats only: days left in the 30-day window before the purge */
  daysLeft?: number;
  restoreId: string;
}

/** A deleted-chat row (the /api/trash shape; deleted_at may be a number or a date string). */
export interface TrashSessionRow {
  id: string;
  title: string;
  deleted_at?: number | string | null;
}

/** A closed-stack row: the live ClosedEntry shapes plus the friendly "tab"/"tab-group" forms. */
export interface TrashClosedRow {
  type: string;
  name?: string;
  at: number;
  panels?: { id?: string; title?: string }[];
}

/** deleted_at arrives as a ms number or a date string; anything unusable means "not trash". */
function stampOf(v: number | string | null | undefined): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
    const parsed = Date.parse(v);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function closedEntry(c: TrashClosedRow, index: number, at: number): TrashEntry | null {
  const fallback = typeof c.name === "string" && c.name ? c.name : undefined;
  switch (c.type) {
    case "workspace":
      return { kind: "workspace", id: `closed:${index}`, title: fallback ?? "Workspace", deletedAt: at, restoreId: String(index) };
    case "tab-group":
      return { kind: "tab-group", id: `closed:${index}`, title: fallback ?? "Tab group", deletedAt: at, restoreId: String(index) };
    case "tab":
      return { kind: "tab", id: `closed:${index}`, title: fallback ?? "Tab", deletedAt: at, restoreId: String(index) };
    case "panels": {
      /* the live undo-stack shape (#115): one panel is a tab close, several a group */
      const panels = Array.isArray(c.panels) ? c.panels : [];
      if (panels.length > 1) {
        return { kind: "tab-group", id: `closed:${index}`, title: fallback ?? `${panels.length} tabs`, deletedAt: at, restoreId: String(index) };
      }
      return { kind: "tab", id: `closed:${index}`, title: fallback ?? (panels[0]?.title || panels[0]?.id || "Tab"), deletedAt: at, restoreId: String(index) };
    }
    default:
      return null;
  }
}

/** One listing, newest first: trashed chats with days-left math + closed workspaces/groups/tabs. */
export function trashEntries(input: {
  sessions: TrashSessionRow[];
  closed: TrashClosedRow[];
  now: number;
}): TrashEntry[] {
  const out: TrashEntry[] = [];
  for (const s of Array.isArray(input.sessions) ? input.sessions : []) {
    if (!s || typeof s.id !== "string") continue;
    const at = stampOf(s.deleted_at);
    if (at === null) continue; // live chats never list
    out.push({
      kind: "session",
      id: s.id,
      title: typeof s.title === "string" && s.title ? s.title : "Chat",
      deletedAt: at,
      daysLeft: daysLeftInTrash(at, input.now),
      restoreId: s.id,
    });
  }
  const closed = Array.isArray(input.closed) ? input.closed : [];
  closed.forEach((c, i) => {
    if (!c || typeof c !== "object") return;
    if (typeof c.at !== "number" || !Number.isFinite(c.at)) return;
    const entry = closedEntry(c, i, c.at);
    if (entry) out.push(entry);
  });
  return out.sort((a, b) => b.deletedAt - a.deletedAt);
}
