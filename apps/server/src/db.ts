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

const insertEvent = db.prepare(`
  INSERT INTO events (session_id, type, payload, at) VALUES (@session_id, @type, @payload, @at)
`);

const listSessionsStmt = db.prepare(`
  SELECT * FROM sessions WHERE state != 'closed' ORDER BY updated_at DESC
`);

const getSessionStmt = db.prepare(`SELECT * FROM sessions WHERE id = ?`);

const listEventsStmt = db.prepare(`
  SELECT payload FROM events WHERE session_id = ? ORDER BY id ASC
`);

export const store = {
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

  getSession(id: string): SessionRow | undefined {
    return getSessionStmt.get(id) as SessionRow | undefined;
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

  /** Replay every persisted event for a session, in order. */
  listEvents(sessionId: string): ProtoEvent[] {
    const rows = listEventsStmt.all(sessionId) as { payload: string }[];
    return rows.map((r) => JSON.parse(r.payload) as ProtoEvent);
  },
};
