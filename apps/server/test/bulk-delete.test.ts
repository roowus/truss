import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freshServer } from "./helpers.js";
import type { AdapterHandle, HarnessAdapter, SessionOpts } from "../src/adapters/types.js";

/* SPEC-TESTS for bulk session delete — https://github.com/roowus/truss/issues/4
   ("Bulk-delete chats under a project/folder — without deleting the folder").
   These FAIL on purpose today: they pin the contract a fix must satisfy.

   NOTE — interplay with issue #5 (30-day trash/recovery): RECONCILED. Trash
   landed first, so bulk delete MOVES TO TRASH (row + log kept, recoverable);
   purge is the only hard delete. The assertions below are the reconciled
   "trashed" forms of the original hard-delete pins.

   Today only single-session delete exists (sessions.deleteSession +
   DELETE /api/sessions/:id?hard=1); bulk exists solely for ARCHIVE
   (setProjectArchived + POST /api/projects/archive). The sidebar groups
   sessions by project tag or by workspace folder and offers per-session
   delete (two-click) — deleting a whole group's chats one by one is the pain.

   The contract: sessions.ts gains a bulk sibling of deleteSession —

     deleteSessions(ids: string[]): number   // sessions actually deleted

   Rules it must honor:
   - each id gets exactly today's single-delete semantics: close (dispose the
     live handle exactly once), remove the row, cascade the event log, and
     broadcast one `session.deleted` per id so every client's sidebar drops it;
   - unknown / already-gone ids are skipped WITHOUT throwing (a stale sidebar
     selection must not abort the batch), and duplicates count once;
   - it is a DATABASE-ONLY operation: the sessions' working directories — the
     "folders" the sidebar groups by — and everything in them stay untouched;
   - sessions not in the list keep their rows and their full history.

   Safety: fake recording adapters only; every path is a per-test tmp dir. */

interface FakeRec {
  sent: string[];
  disposed: string[]; // sessionIds, in order
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
    send(_h: AdapterHandle, text: string) {
      rec.sent.push(text);
    },
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

async function setup(tag: string, harness: string) {
  const { db, cleanup } = await freshServer(tag);
  const sessions: SessionsModule = await import("../src/sessions.js");
  const rec: FakeRec = { sent: [], disposed: [] };
  sessions.registerAdapter(harness as never, fakeAdapter(harness, rec));
  const cwd = join(db.dataDir, "ws");
  mkdirSync(cwd, { recursive: true });
  return { db, sessions, rec, cwd, cleanup: () => { sessions.unregisterAdapter(harness as never); cleanup(); } };
}

function bulkDelete(sessions: SessionsModule, ids: string[]): Promise<number> | number {
  assert.equal(
    typeof (sessions as any).deleteSessions,
    "function",
    "sessions.ts must export deleteSessions(ids: string[]): number — the bulk sibling of deleteSession (see issue #4)",
  );
  return (sessions as any).deleteSessions(ids);
}

test("moves rows to the trash WITH their event logs (recoverable), returns the count", async () => {
  const { db, sessions, cwd, cleanup } = await setup("bulk-basic", "fake-bulk-basic");
  try {
    const a = await sessions.createSession({ harness: "fake-bulk-basic" as never, cwd, project: "nuke" });
    const b = await sessions.createSession({ harness: "fake-bulk-basic" as never, cwd, project: "nuke" });
    await sessions.sendPrompt(a.id, "history for a");
    await sessions.sendPrompt(b.id, "history for b");
    assert.ok(db.store.listEvents(a.id).length > 0 && db.store.listEvents(b.id).length > 0, "seeded history");

    const n = await bulkDelete(sessions, [a.id, b.id]);
    assert.equal(n, 2, "count of actually-trashed sessions");
    assert.ok(db.store.getSession(a.id)?.deleted_at, "row a trashed (recoverable), not destroyed");
    assert.ok(db.store.getSession(b.id)?.deleted_at, "row b trashed");
    assert.ok(db.store.listEvents(a.id).length > 0, "event log SURVIVES — that is the point of trash");
    assert.ok(db.store.listEvents(b.id).length > 0);
    assert.ok(!db.store.listSessions().some((r) => r.id === a.id || r.id === b.id), "out of the main list");
    assert.equal(db.store.listDeletedSessions().length, 2, "both in the trash view");
  } finally {
    cleanup();
  }
});

test("live sessions are closed first — each handle disposed exactly once across close+delete", async () => {
  const { sessions, rec, cwd, cleanup } = await setup("bulk-live", "fake-bulk-live");
  try {
    const live1 = await sessions.createSession({ harness: "fake-bulk-live" as never, cwd });
    const live2 = await sessions.createSession({ harness: "fake-bulk-live" as never, cwd });
    sessions.closeSession(live2.id); // already closed before the batch

    await bulkDelete(sessions, [live1.id, live2.id]);
    assert.deepEqual(
      [...rec.disposed].sort(),
      [live1.id, live2.id].sort(),
      "every handle disposed exactly once — the bulk path must not double-dispose the already-closed one",
    );
  } finally {
    cleanup();
  }
});

test("broadcasts one session.deleted per id so every client's sidebar drops them", async () => {
  const { sessions, cwd, cleanup } = await setup("bulk-broadcast", "fake-bulk-broadcast");
  try {
    const frames: string[] = [];
    sessions.setBroadcaster((f) => {
      if (f.ev.type === "session.deleted") frames.push(f.ev.sessionId);
    });
    try {
      const a = await sessions.createSession({ harness: "fake-bulk-broadcast" as never, cwd });
      const b = await sessions.createSession({ harness: "fake-bulk-broadcast" as never, cwd });
      await bulkDelete(sessions, [a.id, b.id]);
      assert.deepEqual([...frames].sort(), [a.id, b.id].sort(), "one deletion frame per session");
    } finally {
      sessions.setBroadcaster(() => {});
    }
  } finally {
    cleanup();
  }
});

test("unknown ids are skipped without throwing; duplicates count once", async () => {
  const { db, sessions, cwd, cleanup } = await setup("bulk-stale", "fake-bulk-stale");
  try {
    const a = await sessions.createSession({ harness: "fake-bulk-stale" as never, cwd });

    const n = await bulkDelete(sessions, [a.id, "ghost-never-existed", a.id]);
    assert.equal(n, 1, "a stale sidebar selection must not abort or inflate the batch");
    assert.ok(db.store.getSession(a.id)?.deleted_at, "the real one still trashed");

    assert.equal(await bulkDelete(sessions, []), 0, "empty batch is a no-op");
    assert.equal(await bulkDelete(sessions, ["ghost-never-existed"]), 0, "all-stale batch deletes nothing, still no throw");
  } finally {
    cleanup();
  }
});

test("the folder survives: bulk delete never touches the sessions' working directories", async () => {
  const { db, sessions, cwd, cleanup } = await setup("bulk-folder", "fake-bulk-folder");
  try {
    /* the sidebar's folder mode groups by cwd — deleting the chats must not
       delete (or touch) that directory or anything in it */
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "KEEP.txt"), "precious");
    writeFileSync(join(cwd, "src", "KEEP2.txt"), "also precious");
    const a = await sessions.createSession({ harness: "fake-bulk-folder" as never, cwd, title: "work in the folder" });

    await bulkDelete(sessions, [a.id]);
    assert.ok(db.store.getSession(a.id)?.deleted_at, "chat trashed (recoverable via issue #5)");
    assert.equal(readText(join(cwd, "KEEP.txt")), "precious", "files in the folder survive");
    assert.equal(readText(join(cwd, "src", "KEEP2.txt")), "also precious", "nested files survive");
    assert.ok(existsSync(cwd), "the folder itself survives");
  } finally {
    cleanup();
  }
});

function readText(p: string): string {
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

test("sessions outside the batch keep their rows and full history", async () => {
  const { db, sessions, cwd, cleanup } = await setup("bulk-others", "fake-bulk-others");
  try {
    const keep = await sessions.createSession({ harness: "fake-bulk-others" as never, cwd, project: "keep" });
    const nuke1 = await sessions.createSession({ harness: "fake-bulk-others" as never, cwd, project: "nuke" });
    const nuke2 = await sessions.createSession({ harness: "fake-bulk-others" as never, cwd, project: "nuke" });
    await sessions.sendPrompt(keep.id, "keep me");
    await sessions.sendPrompt(nuke1.id, "nuke me");

    /* the sidebar hands over exactly the ids it grouped — everything else,
       including sessions in other projects sharing the same cwd, is off-limits */
    const n = await bulkDelete(sessions, [nuke1.id, nuke2.id]);
    assert.equal(n, 2);
    assert.ok(db.store.getSession(keep.id), "unrelated session row intact");
    assert.ok(db.store.listEvents(keep.id).length > 0, "unrelated session history intact");
  } finally {
    cleanup();
  }
});
