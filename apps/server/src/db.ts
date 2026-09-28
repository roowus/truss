import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProtoEvent, HarnessId, SessionState } from "@truss/proto";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.TRUSS_DATA_DIR ?? join(here, "..", "data");
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
  project: string | null;
  state: SessionState;
  created_at: number;
  updated_at: number;
  harness_ref: string | null;
  archived: number;
}

const insertSession = db.prepare(`
  INSERT INTO sessions (id, harness, title, cwd, model, project, state, created_at, updated_at)
  VALUES (@id, @harness, @title, @cwd, @model, @project, @state, @created_at, @updated_at)
`);

const updateSessionState = db.prepare(`
  UPDATE sessions SET state = @state, updated_at = @at WHERE id = @id
`);

const updateSessionTitle = db.prepare(`
  UPDATE sessions SET title = @title, updated_at = @at WHERE id = @id
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

/* closed sessions stay listed — their transcripts remain replayable history */
const listSessionsStmt = db.prepare(`
  SELECT * FROM sessions ORDER BY updated_at DESC
`);

const getSessionStmt = db.prepare(`SELECT * FROM sessions WHERE id = ?`);

const listEventsStmt = db.prepare(`
  SELECT id, payload FROM events WHERE session_id = ? ORDER BY id ASC
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
    project?: string;
  }): SessionRow {
    const now = Date.now();
    insertSession.run({
      id: s.id,
      harness: s.harness,
      title: s.title,
      cwd: s.cwd,
      model: s.model ?? null,
      project: s.project ?? null,
      state: "spawning",
      created_at: now,
      updated_at: now,
    });
    return getSessionStmt.get(s.id) as SessionRow;
  },

  setSessionState(id: string, state: SessionState) {
    updateSessionState.run({ id, state, at: Date.now() });
  },

  setSessionTitle(id: string, title: string) {
    updateSessionTitle.run({ id, title, at: Date.now() });
  },

  /** import path: full control of timestamps (the log's own clock) */
  createSessionRaw(s: {
    id: string;
    harness: HarnessId;
    title: string;
    cwd: string;
    model?: string;
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
      project: s.project ?? null,
      state: s.state,
      created_at: s.created_at,
      updated_at: s.updated_at,
    });
    return getSessionStmt.get(s.id) as SessionRow;
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

  /** every session carrying a project tag (for bulk archive) */
  sessionsInProject(project: string): SessionRow[] {
    return db.prepare(`SELECT * FROM sessions WHERE project = @p`).all({ p: project }) as SessionRow[];
  },

  getKv(key: string): string | undefined {
    const row = kvGet.get(key) as { value: string } | undefined;
    return row?.value;
  },

  setKv(key: string, value: string) {
    kvSet.run({ key, value, at: Date.now() });
  },

  getSession(id: string): SessionRow | undefined {
    return getSessionStmt.get(id) as SessionRow | undefined;
  },

  /** hard delete — row + full event log (CASCADE) */
  deleteSession(id: string) {
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  },

  listSessions(): SessionRow[] {
    return listSessionsStmt.all() as SessionRow[];
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
    const rows = listEventsStmt.all(sessionId) as { id: number; payload: string }[];
    return rows.map((r) => ({ seq: r.id, ev: JSON.parse(r.payload) as ProtoEvent }));
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
