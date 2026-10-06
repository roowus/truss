import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProtoEvent, HarnessId, SessionState } from "@truss/proto";

const here = dirname(fileURLToPath(import.meta.url));
export const dataDir = process.env.TRUSS_DATA_DIR ?? join(here, "..", "data");
mkdirSync(dataDir, { recursive: true });

const db: Database.Database = new Database(join(dataDir, "truss.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  harness     TEXT NOT NULL,
  title       TEXT NOT NULL,
  cwd         TEXT NOT NULL,
  model       TEXT,
  project     TEXT,
  state       TEXT NOT NULL DEFAULT 'spawning',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  payload     TEXT NOT NULL,
  at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, id);
`);

/* migration: harness_ref = the harness's own session id (pi sessionId,
   claude session_id, dsh/hermes ACP sessionId) for resume-across-restart */
const sessionCols = db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[];
if (!sessionCols.some((c) => c.name === "harness_ref")) {
  db.exec(`ALTER TABLE sessions ADD COLUMN harness_ref TEXT`);
}
/* migration: archived hides a session from the sidebar without deleting it */
if (!sessionCols.some((c) => c.name === "archived")) {
  db.exec(`ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`);
}
/* migration: provider pairs with model — resume without it sends e.g. a
   fireworks model id to the default provider (400 Unknown Model) */
if (!sessionCols.some((c) => c.name === "provider")) {
  db.exec(`ALTER TABLE sessions ADD COLUMN provider TEXT`);
}
/* migration: deleted_at = the 30-day trash stamp (issue #5). Row + event
   log survive a delete; purge is the only true delete. */
if (!sessionCols.some((c) => c.name === "deleted_at")) {
  db.exec(`ALTER TABLE sessions ADD COLUMN deleted_at INTEGER`);
}
/* migration: pinned floats a session to the top of its sidebar section
   (issue #86) — orthogonal to archived/state, a pinned archived chat stays
   archived */
if (!sessionCols.some((c) => c.name === "pinned")) {
  db.exec(`ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
}

/* server-level key-value store (layout persistence, future settings) */
db.exec(`
CREATE TABLE IF NOT EXISTS kv (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
`);

export interface SessionRow {
  id: string;
  harness: HarnessId;
  title: string;
  cwd: string;
  model: string | null;
  provider: string | null;
  project: string | null;
  state: SessionState;
  created_at: number;
  updated_at: number;
  harness_ref: string | null;
  archived: number;
  /* boolean at the store boundary (unlike the older archived 0/1) — the
     sidebar's pin key and the #86 contract want a real flag, not SQLite's int */
  pinned: boolean;
  deleted_at: number | null;
}

/* sqlite stores pinned as 0/1; every read path normalizes to a boolean */
function asSessionRow(r: unknown): SessionRow {
  const row = r as Omit<SessionRow, "pinned"> & { pinned: number };
  return { ...row, pinned: !!row.pinned };
}

const insertSession = db.prepare(`
  INSERT INTO sessions (id, harness, title, cwd, model, provider, project, state, created_at, updated_at)
  VALUES (@id, @harness, @title, @cwd, @model, @provider, @project, @state, @created_at, @updated_at)
`);

const updateSessionState = db.prepare(`
  UPDATE sessions SET state = @state, updated_at = @at WHERE id = @id
`);

const updateSessionTitle = db.prepare(`
  UPDATE sessions SET title = @title, updated_at = @at WHERE id = @id
`);

const updateSessionModel = db.prepare(`
  UPDATE sessions SET model = @model, provider = @provider, updated_at = @at WHERE id = @id
`);

const updateHarnessRef = db.prepare(`
  UPDATE sessions SET harness_ref = @ref, updated_at = @at WHERE id = @id
`);

const kvGet = db.prepare(`SELECT value FROM kv WHERE key = ?`);
const kvSet = db.prepare(`
  INSERT INTO kv (key, value, updated_at) VALUES (@key, @value, @at)
  ON CONFLICT(key) DO UPDATE SET value = @value, updated_at = @at
`);

const insertEvent = db.prepare(`
  INSERT INTO events (session_id, type, payload, at) VALUES (@session_id, @type, @payload, @at)
`);

/* closed sessions stay listed — their transcripts remain replayable history;
   trashed ones leave the list until restored (issue #5) */
const listSessionsStmt = db.prepare(`
  SELECT * FROM sessions WHERE deleted_at IS NULL ORDER BY updated_at DESC
`);

const listDeletedSessionsStmt = db.prepare(`
  SELECT * FROM sessions WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC
`);

const knownHarnessRefsStmt = db.prepare(`
  SELECT harness_ref FROM sessions WHERE harness_ref IS NOT NULL
`);

const getSessionStmt = db.prepare(`SELECT * FROM sessions WHERE id = ?`);

const listEventsStmt = db.prepare(`
  SELECT id, payload, at FROM events WHERE session_id = ? ORDER BY id ASC
`);

export const store = {
  /* generic helpers for feature tables (tasks, …) that keep their own modules */
  exec(sql: string) {
    db.exec(sql);
  },
  run(sql: string, ...params: unknown[]) {
    return db.prepare(sql).run(...(params as never[]));
  },
  get<T>(sql: string, ...params: unknown[]): T | undefined {
    return db.prepare(sql).get(...(params as never[])) as T | undefined;
  },
  all<T>(sql: string, ...params: unknown[]): T[] {
    return db.prepare(sql).all(...(params as never[])) as T[];
  },

  createSession(s: {
    id: string;
    harness: HarnessId;
    title: string;
    cwd: string;
    model?: string;
    provider?: string;
    project?: string;
  }): SessionRow {
    const now = Date.now();
    insertSession.run({
      id: s.id,
      harness: s.harness,
      title: s.title,
      cwd: s.cwd,
      model: s.model ?? null,
      provider: s.provider ?? null,
      project: s.project ?? null,
      state: "spawning",
      created_at: now,
      updated_at: now,
    });
    const row = getSessionStmt.get(s.id);
    return asSessionRow(row);
  },

  setSessionState(id: string, state: SessionState) {
    updateSessionState.run({ id, state, at: Date.now() });
  },

  setSessionTitle(id: string, title: string) {
    updateSessionTitle.run({ id, title, at: Date.now() });
  },

  /** model + provider move together — storing one without the other is how
     resumed sessions ended up sending fireworks ids to the zai endpoint */
  setSessionModel(id: string, model: string | null, provider: string | null) {
    updateSessionModel.run({ id, model, provider, at: Date.now() });
  },

  /** import path: full control of timestamps (the log's own clock) */
  createSessionRaw(s: {
    id: string;
    harness: HarnessId;
    title: string;
    cwd: string;
    model?: string;
    provider?: string;
    project?: string;
    state: SessionState;
    created_at: number;
    updated_at: number;
  }) {
    insertSession.run({
      id: s.id,
      harness: s.harness,
      title: s.title,
      cwd: s.cwd,
      model: s.model ?? null,
      provider: s.provider ?? null,
      project: s.project ?? null,
      state: s.state,
      created_at: s.created_at,
      updated_at: s.updated_at,
    });
    const row = getSessionStmt.get(s.id);
    return asSessionRow(row);
  },

  setHarnessRef(id: string, ref: string) {
    updateHarnessRef.run({ id, ref, at: Date.now() });
  },

  setSessionProject(id: string, project: string | null) {
    db.prepare(`UPDATE sessions SET project = @p, updated_at = @at WHERE id = @id`).run({
      id, p: project, at: Date.now(),
    });
  },

  setArchived(id: string, archived: boolean) {
    db.prepare(`UPDATE sessions SET archived = @a, updated_at = @at WHERE id = @id`).run({
      id, a: archived ? 1 : 0, at: Date.now(),
    });
  },

  /* pin deliberately does NOT bump updated_at (unlike archive): the row
     stays visible, so a bump would reset its "ago" label and strand it at
     the top of the recency partition after an unpin (audit B1, issue #86) */
  setPinned(id: string, pinned: boolean) {
    db.prepare(`UPDATE sessions SET pinned = @p WHERE id = @id`).run({
      id, p: pinned ? 1 : 0,
    });
  },

  /** every session carrying a project tag (for bulk archive) */
  sessionsInProject(project: string): SessionRow[] {
    return (db.prepare(`SELECT * FROM sessions WHERE project = @p`).all({ p: project }) as unknown[]).map(asSessionRow);
  },

  getKv(key: string): string | undefined {
    const row = kvGet.get(key) as { value: string } | undefined;
    return row?.value;
  },

  setKv(key: string, value: string) {
    kvSet.run({ key, value, at: Date.now() });
  },

  getSession(id: string): SessionRow | undefined {
    const row = getSessionStmt.get(id);
    return row ? asSessionRow(row) : undefined;
  },

  /** hard delete — row + full event log (CASCADE) */
  deleteSession(id: string) {
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  },

  listSessions(): SessionRow[] {
    return (listSessionsStmt.all() as unknown[]).map(asSessionRow);
  },

  /** the 30-day trash (issue #5): stamped rows, newest first */
  listDeletedSessions(): SessionRow[] {
    return (listDeletedSessionsStmt.all() as unknown[]).map(asSessionRow);
  },

  /** every harness_ref ever seen, trashed rows included — import dedupe must
     not lose a ref just because its session is in the trash (issue #5) */
  knownHarnessRefs(): string[] {
    return (knownHarnessRefsStmt.all() as { harness_ref: string }[]).map((r) => r.harness_ref);
  },

  setDeletedAt(id: string, at: number | null) {
    db.prepare(`UPDATE sessions SET deleted_at = ?, updated_at = ? WHERE id = ?`).run(at, Date.now(), id);
  },

  /** Persist one proto event. Returns the assigned rowid (monotonic per session). */
  appendEvent(ev: ProtoEvent): number {
    const info = insertEvent.run({
      session_id: ev.sessionId,
      type: ev.type,
      payload: JSON.stringify(ev),
      at: Date.now(),
    });
    return Number(info.lastInsertRowid);
  },

  /** Replay every persisted event for a session, in order, with rowids for dedupe. */
  listEvents(sessionId: string): { seq: number; ev: ProtoEvent }[] {
    const rows = listEventsStmt.all(sessionId) as { id: number; payload: string; at: number }[];
    /* Rows persisted before the sink stamped `at` carry no time of their
       own — hand back the row's wall-clock instead, or replay collapses
       every unstamped done-span to a fabricated 0ms (issue #142 audit).
       Exception: imported dsh logs (the importer names its rows `dsh-*`)
       are inserted in one synchronous batch, so the row time is the import
       instant, not the event time — injecting it would fabricate spans as
       long as the session's age at import. Those stay timeless here and
       fall back to the client's replay clock: bounded, and honest — dsh
       records a message as a single record, so the real span is ~0. */
    const isImport = sessionId.startsWith("dsh-");
    return rows.map((r) => {
      const ev = JSON.parse(r.payload) as ProtoEvent;
      if (!isImport && (ev as { at?: unknown }).at === undefined) (ev as { at?: unknown }).at = r.at;
      return { seq: r.id, ev };
    });
  },

  /** per-day token/cost buckets for the heat grid + trend (local time, last `days`) */
  costDaily(days = 35): {
    day: string; // YYYY-MM-DD local
    calls: number;
    tokensIn: number;
    tokensOut: number;
    costUsd: number | null;
  }[] {
    const since = Date.now() - days * 86_400_000;
    return db
      .prepare(
        `
      SELECT date(e.at / 1000, 'unixepoch', 'localtime') AS day,
             COUNT(*) AS calls,
             COALESCE(SUM(json_extract(e.payload, '$.tokensIn')), 0) AS tokensIn,
             COALESCE(SUM(json_extract(e.payload, '$.tokensOut')), 0) AS tokensOut,
             SUM(json_extract(e.payload, '$.costUsd')) AS costUsd
      FROM events e
      WHERE e.type = 'llm.call.done' AND e.at >= ?
      GROUP BY day
      ORDER BY day ASC
      `,
      )
      .all(since) as never;
  },

  /** per-session cost rollup from llm.call.done events (null cost = none reported) */
  costRollup(): {
    id: string;
    title: string;
    harness: string;
    state: string;
    updated_at: number;
    calls: number;
    tokensIn: number;
    tokensOut: number;
    costUsd: number | null;
  }[] {
    return db
      .prepare(
        `
      SELECT s.id, s.title, s.harness, s.state, s.updated_at,
             COUNT(*) AS calls,
             COALESCE(SUM(json_extract(e.payload, '$.tokensIn')), 0) AS tokensIn,
             COALESCE(SUM(json_extract(e.payload, '$.tokensOut')), 0) AS tokensOut,
             SUM(json_extract(e.payload, '$.costUsd')) AS costUsd
      FROM sessions s
      JOIN events e ON e.session_id = s.id AND e.type = 'llm.call.done'
      GROUP BY s.id
      ORDER BY costUsd IS NULL, costUsd DESC, s.updated_at DESC
      `,
      )
      .all() as never;
  },
};
