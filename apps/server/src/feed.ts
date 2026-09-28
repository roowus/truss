import { randomUUID } from "node:crypto";
import { store } from "./db.js";
import type { FeedItem, FeedState, FeedType, FeedImportance } from "@truss/proto";

/**
 * The feed — Truss's unified inbox. Auto-posters (permission requests, work
 * finished, task runs, errors, context pressure) and agents (reports, notes)
 * file cards here; a card stays until the user marks it read, saves it,
 * dismisses it, or does the thing. Cards can be shared onward into agent
 * sessions (chat message + agent-visible sharedWith for list_feed).
 *
 * Live sync: every mutation broadcasts feed.upsert (not persisted in the
 * events log — this table IS the log; clients load via REST and patch live).
 */

interface FeedRow {
  id: string;
  type: string;
  session_id: string | null;
  title: string;
  body: string;
  importance: string;
  data: string;
  state: string;
  shared_with: string;
  dedupe_key: string | null;
  created_at: number;
  updated_at: number;
}

let ready = false;
function table() {
  if (ready) return;
  store.exec(`
    CREATE TABLE IF NOT EXISTS feed_items (
      id          TEXT PRIMARY KEY,
      type        TEXT NOT NULL,
      session_id  TEXT,
      title       TEXT NOT NULL,
      body        TEXT NOT NULL DEFAULT '',
      importance  TEXT NOT NULL DEFAULT 'normal',
      data        TEXT NOT NULL DEFAULT '{}',
      state       TEXT NOT NULL DEFAULT 'unread',
      shared_with TEXT NOT NULL DEFAULT '[]',
      dedupe_key  TEXT UNIQUE,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_feed_state ON feed_items(state, created_at DESC);
  `);
  ready = true;
}

function camel(r: FeedRow): FeedItem {
  return {
    id: r.id,
    type: r.type as FeedType,
    sessionId: r.session_id ?? undefined,
    title: r.title,
    body: r.body,
    importance: r.importance as FeedImportance,
    data: JSON.parse(r.data || "{}"),
    state: r.state as FeedState,
    sharedWith: JSON.parse(r.shared_with || "[]"),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

let broadcast: (item: FeedItem) => void = () => {};
/** sessions.ts wires the event-bus fan-out here at boot */
export function setFeedBroadcaster(fn: (item: FeedItem) => void) {
  broadcast = fn;
}

export function listFeed(opts: { state?: FeedState; sharedWith?: string; limit?: number } = {}): FeedItem[] {
  table();
  const limit = Math.min(opts.limit ?? 500, 2000);
  if (opts.sharedWith) {
    /* agent view: only cards shared to this session (json_each over the array) */
    return store
      .all<FeedRow>(
        /* feed_items.* — plain SELECT * would let json_each's own id/type
           columns clobber the card's (agents got id=1, type="text") */
        `SELECT feed_items.* FROM feed_items, json_each(feed_items.shared_with) je
         WHERE je.value = ? AND state != 'dismissed' ORDER BY created_at DESC LIMIT ?`,
        opts.sharedWith, limit,
      )
      .map(camel);
  }
  if (opts.state) {
    return store.all<FeedRow>(`SELECT * FROM feed_items WHERE state = ? ORDER BY created_at DESC LIMIT ?`, opts.state, limit).map(camel);
  }
  /* default inbox view: everything not dismissed */
  return store.all<FeedRow>(`SELECT * FROM feed_items WHERE state != 'dismissed' ORDER BY created_at DESC LIMIT ?`, limit).map(camel);
}

export function getFeedItem(id: string): FeedItem | undefined {
  table();
  const r = store.get<FeedRow>(`SELECT * FROM feed_items WHERE id = ?`, id);
  return r ? camel(r) : undefined;
}

export function postFeed(input: {
  type: FeedType;
  title: string;
  body?: string;
  sessionId?: string;
  importance?: FeedImportance;
  data?: Record<string, unknown>;
  sharedWith?: string[];
  dedupeKey?: string;
  state?: FeedState;
}): { item: FeedItem; created: boolean } {
  table();
  if (input.dedupeKey) {
    const dup = store.get<FeedRow>(`SELECT * FROM feed_items WHERE dedupe_key = ?`, input.dedupeKey);
    if (dup) return { item: camel(dup), created: false };
  }
  const now = Date.now();
  const id = randomUUID().slice(0, 8);
  store.run(
    `INSERT INTO feed_items (id, type, session_id, title, body, importance, data, state, shared_with, dedupe_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, input.type, input.sessionId ?? null, input.title, input.body ?? "",
    input.importance ?? "normal", JSON.stringify(input.data ?? {}),
    input.state ?? "unread", JSON.stringify(input.sharedWith ?? []),
    input.dedupeKey ?? null, now, now,
  );
  const item = getFeedItem(id)!;
  broadcast(item);
  return { item, created: true };
}

const FEED_STATES: FeedState[] = ["unread", "read", "saved", "dismissed", "done"];

export function setFeedState(id: string, state: FeedState): FeedItem {
  table();
  if (!FEED_STATES.includes(state)) throw new Error(`bad state: ${state}`);
  const r = store.run(`UPDATE feed_items SET state = ?, updated_at = ? WHERE id = ?`, state, Date.now(), id);
  if (r.changes === 0) throw new Error(`no such feed item: ${id}`);
  const item = getFeedItem(id)!;
  broadcast(item);
  return item;
}

export function shareFeedItem(id: string, sessionId: string): FeedItem {
  table();
  const item = getFeedItem(id);
  if (!item) throw new Error(`no such feed item: ${id}`);
  if (!item.sharedWith.includes(sessionId)) {
    store.run(`UPDATE feed_items SET shared_with = ?, updated_at = ? WHERE id = ?`, JSON.stringify([...item.sharedWith, sessionId]), Date.now(), id);
  }
  const next = getFeedItem(id)!;
  broadcast(next);
  return next;
}

/** resolve every open card of a type+dedupe prefix (e.g. a perm handled in chat) */
export function settleFeedWhere(dedupePrefix: string, state: FeedState = "done") {
  table();
  const rows = store.all<FeedRow>(
    `SELECT * FROM feed_items WHERE dedupe_key LIKE ? AND state IN ('unread','read')`,
    `${dedupePrefix}%`,
  );
  for (const r of rows) setFeedState(r.id, state);
  return rows.length;
}

/* ── settings: which auto-posters are on (live in the layout doc's settings) ── */

export interface FeedSources {
  permissions: boolean;
  workDone: boolean;
  taskRuns: boolean;
  errors: boolean;
  context: boolean;
}

export function feedSources(): FeedSources {
  const def: FeedSources = { permissions: true, workDone: true, taskRuns: true, errors: true, context: true };
  try {
    const raw = store.getKv("dockview-layout");
    if (!raw) return def;
    const doc = JSON.parse(raw);
    return { ...def, ...(doc?.settings?.feedSources ?? {}) };
  } catch {
    return def;
  }
}
