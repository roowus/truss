import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { freshServer } from "./helpers.js";
import type { AdapterHandle, HarnessAdapter, SessionOpts } from "../src/adapters/types.js";

/* SPEC-TESTS for 30-day deleted-chat recovery — https://github.com/roowus/truss/issues/5
   These pin the contract the issue demanded; the fix landed with them, so
   they pass.

   Today sessions.deleteSession is a HARD delete: the row goes, the FK cascade
   wipes the event log, and session.deleted is broadcast-only because nothing
   remains to replay. One misclick (or an over-eager bulk delete, issue #4)
   destroys a transcript forever.

   The contract — delete becomes a 30-day trash move:

   1. sessions.deleteSession(id) goes SOFT: dispose the live handle (unchanged),
      stamp the row's deleted_at (new nullable column, migrated like archived),
      keep the entire event log, and still broadcast session.deleted so live
      clients drop it from the sidebar. store.listSessions() EXCLUDES trashed
      rows; new store.listDeletedSessions() feeds a "recently deleted" view.
      (store.deleteSession stays the hard-delete PRIMITIVE — db.test.ts &
      friends rely on it — it becomes the purge path's tool, not the UI's.)

   2. sessions.restoreSession(id): clears deleted_at, the chat returns to
      listSessions() with its full history, and a session.updated broadcast
      tells other clients.

   3. sessions.purgeExpiredTrash(now?): hard-deletes trash older than
      sessions.TRASH_RETENTION_MS (exactly 30 days), returns the purged ids,
      and broadcasts session.deleted for each. Called at boot (reconcileOnBoot
      precedent) and on a daily timer — wiring is acceptance criteria.

   4. sessions.purgeSession(id): "delete forever" from the trash view —
      immediate hard delete regardless of age.

   Interplay: when issue #4's bulk delete lands it wraps THIS soft delete;
   its "row/events gone" assertions become "trashed" assertions at that point.

   Safety: fake recording adapters; per-test tmp dirs; the store's own
   hard-delete primitive and every existing suite must stay green. */

interface FakeRec {
  disposed: string[];
}

function fakeAdapter(id: string, rec: FakeRec): HarnessAdapter {
  return {
    id: id as never,
    capabilities: { permissions: false, subagents: false, streaming: true, queueWhileRunning: true },
    async listModels() {
      return [];
    },
    async spawn(opts: SessionOpts): Promise<AdapterHandle> {
      return { sessionId: opts.sessionId };
    },
    send() {},
    interrupt() {},
    async *events() {
      await new Promise(() => {});
      yield undefined as never;
    },
    dispose(h: AdapterHandle) {
      rec.disposed.push(h.sessionId);
    },
  };
}

type SessionsModule = typeof import("../src/sessions.js");
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

async function setup(tag: string, harness: string) {
  const { db, cleanup } = await freshServer(tag);
  const sessions: SessionsModule = await import("../src/sessions.js");
  const rec: FakeRec = { disposed: [] };
  sessions.registerAdapter(harness as never, fakeAdapter(harness, rec));
  const cwd = join(db.dataDir, "ws");
  mkdirSync(cwd, { recursive: true });
  const frames: { type: string; sessionId?: string }[] = [];
  sessions.setBroadcaster((f) => frames.push({ type: f.ev.type, sessionId: (f.ev as { sessionId?: string }).sessionId }));
  return {
    db,
    sessions,
    rec,
    cwd,
    frames,
    cleanup: () => {
      sessions.setBroadcaster(() => {});
      sessions.unregisterAdapter(harness as never);
      cleanup();
    },
  };
}

const deletedAtOf = (db: any, id: string): number | null | undefined =>
  db.store.get(`SELECT deleted_at FROM sessions WHERE id = ?`, id)?.deleted_at as number | null | undefined;

test("delete is a trash move: row + full history retained, stamped, hidden, handle disposed, deletion broadcast", async () => {
  const { db, sessions, rec, cwd, frames, cleanup } = await setup("trash-soft", "fake-trash-soft");
  try {
    const s = await sessions.createSession({ harness: "fake-trash-soft" as never, cwd, title: "precious chat" });
    await sessions.sendPrompt(s.id, "history that must survive deletion");
    const before = db.store.listEvents(s.id).length;
    assert.ok(before > 0, "seeded history");

    const at = Date.now();
    sessions.deleteSession(s.id);

    assert.ok(db.store.getSession(s.id), "SOFT delete: the row is still there (today it is hard-deleted — this is the bug)");
    assert.ok(db.store.listEvents(s.id).length === before, "the event log survives — the transcript is the thing being recovered");
    const deletedAt = deletedAtOf(db, s.id);
    assert.ok(typeof deletedAt === "number" && deletedAt >= at - 1000 && deletedAt <= Date.now() + 1000, "deleted_at stamped around now");
    assert.ok(!db.store.listSessions().some((r: { id: string }) => r.id === s.id), "trashed chats leave the main session list");
    assert.ok(
      (db.store as any).listDeletedSessions?.().some((r: { id: string }) => r.id === s.id),
      "store.listDeletedSessions() feeds the recently-deleted view",
    );
    assert.deepEqual(rec.disposed, [s.id], "live handle disposed exactly as today");
    assert.ok(frames.some((f) => f.type === "session.deleted" && f.sessionId === s.id), "session.deleted still broadcast (clients drop it live)");
  } finally {
    cleanup();
  }
});

test("restoreSession brings the chat back with its full history and tells every client", async () => {
  const { db, sessions, cwd, frames, cleanup } = await setup("trash-restore", "fake-trash-restore");
  try {
    const s = await sessions.createSession({ harness: "fake-trash-restore" as never, cwd, title: "oops, need this back" });
    await sessions.sendPrompt(s.id, "transcript to restore");
    sessions.deleteSession(s.id);

    assert.equal(typeof (sessions as any).restoreSession, "function", "sessions.ts must export restoreSession(id) — see issue #5");
    (sessions as any).restoreSession(s.id);

    assert.equal(deletedAtOf(db, s.id), null, "trash stamp cleared");
    assert.ok(db.store.listSessions().some((r: { id: string }) => r.id === s.id), "back in the main list");
    assert.ok(db.store.listEvents(s.id).length > 0, "history intact across the round-trip");
    assert.ok(frames.some((f) => f.type === "session.updated" && f.sessionId === s.id), "a session.updated broadcast lets other clients re-list it");
  } finally {
    cleanup();
  }
});

test("TRASH_RETENTION_MS is exactly 30 days — the number in the feature's name", async () => {
  const { sessions, cleanup } = await setup("trash-constant", "fake-trash-const");
  try {
    assert.equal((sessions as any).TRASH_RETENTION_MS, THIRTY_DAYS, "30 * 24 * 60 * 60 * 1000");
  } finally {
    cleanup();
  }
});

test("purgeExpiredTrash hard-deletes only trash past 30 days; the rest of the trash survives", async () => {
  const { db, sessions, cwd, frames, cleanup } = await setup("trash-purge", "fake-trash-purge");
  try {
    const ancient = await sessions.createSession({ harness: "fake-trash-purge" as never, cwd, title: "ancient trash" });
    const recent = await sessions.createSession({ harness: "fake-trash-purge" as never, cwd, title: "recent trash" });
    const alive = await sessions.createSession({ harness: "fake-trash-purge" as never, cwd, title: "never deleted" });
    for (const id of [ancient.id, recent.id]) await sessions.sendPrompt(id, "trash history");
    await sessions.sendPrompt(alive.id, "alive history");
    sessions.deleteSession(ancient.id);
    sessions.deleteSession(recent.id);

    assert.equal(typeof (sessions as any).purgeExpiredTrash, "function", "sessions.ts must export purgeExpiredTrash(now?) — see issue #5");

    /* backdate the stamps directly: one just past the window, one inside it */
    const now = Date.now();
    db.store.run(`UPDATE sessions SET deleted_at = ? WHERE id = ?`, now - THIRTY_DAYS - 60_000, ancient.id);
    db.store.run(`UPDATE sessions SET deleted_at = ? WHERE id = ?`, now - THIRTY_DAYS + 60_000, recent.id);

    const purged: string[] = (sessions as any).purgeExpiredTrash(now);
    assert.ok(purged.includes(ancient.id), "31-day-old trash is purged");
    assert.ok(!purged.includes(recent.id), "29-day-23-hour trash is still recoverable");

    assert.equal(db.store.getSession(ancient.id), undefined, "purged row really gone");
    assert.deepEqual(db.store.listEvents(ancient.id), [], "purged event log really gone");
    assert.ok(db.store.getSession(recent.id), "recent trash retained");
    assert.ok(db.store.listEvents(recent.id).length > 0, "recent trash history retained");
    assert.ok(db.store.getSession(alive.id), "never-deleted sessions are untouchable");
    assert.ok(db.store.listEvents(alive.id).length > 0);
    assert.ok(frames.some((f) => f.type === "session.deleted" && f.sessionId === ancient.id), "purge broadcasts session.deleted so open clients drop it");
  } finally {
    cleanup();
  }
});

test("purgeSession deletes forever immediately, regardless of age", async () => {
  const { db, sessions, cwd, cleanup } = await setup("trash-forever", "fake-trash-forever");
  try {
    const s = await sessions.createSession({ harness: "fake-trash-forever" as never, cwd });
    await sessions.sendPrompt(s.id, "really really delete this");
    sessions.deleteSession(s.id);
    assert.ok(db.store.getSession(s.id), "trashed, recoverable");

    assert.equal(typeof (sessions as any).purgeSession, "function", "sessions.ts must export purgeSession(id) — the trash view's 'delete forever' — see issue #5");
    (sessions as any).purgeSession(s.id);

    assert.equal(db.store.getSession(s.id), undefined, "row gone for good");
    assert.deepEqual(db.store.listEvents(s.id), [], "log gone for good");
  } finally {
    cleanup();
  }
});

test("restore/purge of unknown ids fail cleanly, not with a crash or silent no-op", async () => {
  const { sessions, cleanup } = await setup("trash-edge", "fake-trash-edge");
  try {
    assert.throws(() => (sessions as any).restoreSession?.("ghost-id"), /no such|not found|unknown|trash/i, "restore of a ghost says so");
    assert.throws(() => (sessions as any).purgeSession?.("ghost-id"), /no such|not found|unknown|trash/i, "purge of a ghost says so");
  } finally {
    cleanup();
  }
});

test("purgeExpiredTrash honors the saved trashRetentionDays setting (issue #30 audit, finding B2)", async () => {
  /* the settings page's "Keep deleted chats for (days)" used to be a placebo:
     the purge read only the hardcoded TRASH_RETENTION_MS. Now the sweep reads
     the value saved in the layout doc's settings (same home as the feed
     sources), falling back to the 30-day default when unset or invalid. */
  const { db, sessions, cwd, cleanup } = await setup("trash-retention", "fake-trash-retention");
  try {
    const old = await sessions.createSession({ harness: "fake-trash-retention" as never, cwd, title: "old trash" });
    const recent = await sessions.createSession({ harness: "fake-trash-retention" as never, cwd, title: "fresh trash" });
    sessions.deleteSession(old.id);
    sessions.deleteSession(recent.id);

    assert.equal(typeof (sessions as any).trashRetentionMs, "function", "sessions.ts must export trashRetentionMs() — the setting-driven window");
    assert.equal((sessions as any).trashRetentionMs(), THIRTY_DAYS, "no saved setting → the 30-day default");

    /* a 10-day window saved by the settings page */
    db.store.setKv("dockview-layout", JSON.stringify({ version: 2, settings: { trashRetentionDays: 10 } }));
    assert.equal((sessions as any).trashRetentionMs(), 10 * 24 * 60 * 60 * 1000);

    const now = Date.now();
    db.store.run(`UPDATE sessions SET deleted_at = ? WHERE id = ?`, now - 15 * 24 * 60 * 60 * 1000, old.id);
    db.store.run(`UPDATE sessions SET deleted_at = ? WHERE id = ?`, now - 5 * 24 * 60 * 60 * 1000, recent.id);

    const purged: string[] = (sessions as any).purgeExpiredTrash(now);
    assert.ok(purged.includes(old.id), "15-day-old trash is past a 10-day window — purged");
    assert.ok(!purged.includes(recent.id), "5-day-old trash survives a 10-day window");
    assert.equal(db.store.getSession(old.id), undefined, "purged row really gone");
    assert.ok(db.store.getSession(recent.id), "fresh trash retained");

    /* nonsense saved values never shrink the window to zero */
    db.store.setKv("dockview-layout", JSON.stringify({ version: 2, settings: { trashRetentionDays: 0 } }));
    assert.equal((sessions as any).trashRetentionMs(), THIRTY_DAYS, "0 days is nonsense — the default applies");
    db.store.setKv("dockview-layout", "not json{");
    assert.equal((sessions as any).trashRetentionMs(), THIRTY_DAYS, "an unreadable layout doc — the default applies");
  } finally {
    cleanup();
  }
});
