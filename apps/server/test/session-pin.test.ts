import { test } from "node:test";
import assert from "node:assert/strict";
import { freshServer } from "./helpers.js";
import type { AdapterHandle, HarnessAdapter, SessionOpts } from "../src/adapters/types.js";

/* SPEC-TESTS for pinning sidebar entries — https://github.com/roowus/truss/issues/86
   ("Add pinning: chats, shells, etc."). These FAIL on purpose today: they
   pin the contract a fix must satisfy.

   Nothing pins today (repo-wide grep: no pin/star anywhere). The sidebar
   orders chats by recency, shells by insertion, hosts by creation — a busy
   day buries the three things you actually live in.

   The contract (sessions half — the archived flag is the template,
   sessions.ts:476-481):

     setSessionPinned(id, pinned)  — toggles a new `pinned` column
                                     (migration like archived/provider),
                                     broadcasts session.updated with the flag
     listSessions() rows carry pinned

   - pin is ORTHOGONAL to archived/state: a pinned archived session stays
     archived; pinning never changes lifecycle state;
   - unknown id → a clean error;
   - the flag round-trips through the event replay (the broadcast carries it,
     so other clients' sidebars reorder live).

   Shells/hosts halves live in terminal-pin.test.ts; the UI sort pin in
   apps/web/test/pinSort.test.ts. */

function fakeAdapter(id: string): HarnessAdapter {
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
    dispose() {},
  };
}

test("setSessionPinned toggles a persisted flag; listSessions carries it", async () => {
  const { db, cleanup } = await freshServer("pin-basic");
  const sessions = await import("../src/sessions.js");
  sessions.registerAdapter("fake-pin" as never, fakeAdapter("fake-pin"));
  try {
    const s = await sessions.createSession({ harness: "fake-pin" as never, cwd: "/tmp" });
    assert.equal(typeof (sessions as any).setSessionPinned, "function", "sessions.ts must export setSessionPinned — see issue #86");

    (sessions as any).setSessionPinned(s.id, true);
    const row = db.store.listSessions().find((r: any) => r.id === s.id) as any;
    assert.equal(row.pinned, true, "the row carries the pin");

    (sessions as any).setSessionPinned(s.id, false);
    assert.equal((db.store.listSessions().find((r: any) => r.id === s.id) as any).pinned, false, "unpin clears it");
  } finally {
    sessions.unregisterAdapter("fake-pin" as never);
    cleanup();
  }
});

test("pin broadcasts session.updated with the flag (other clients reorder live)", async () => {
  const { cleanup } = await freshServer("pin-broadcast");
  const sessions = await import("../src/sessions.js");
  sessions.registerAdapter("fake-pin2" as never, fakeAdapter("fake-pin2"));
  const frames: any[] = [];
  sessions.setBroadcaster((f: any) => frames.push(f.ev));
  try {
    const s = await sessions.createSession({ harness: "fake-pin2" as never, cwd: "/tmp" });
    frames.length = 0;
    (sessions as any).setSessionPinned(s.id, true);
    const upd = frames.find((e) => e.type === "session.updated" && e.sessionId === s.id);
    assert.ok(upd, "a session.updated fires");
    assert.equal(upd.pinned, true, "and it carries the pin");
  } finally {
    sessions.setBroadcaster(() => {});
    sessions.unregisterAdapter("fake-pin2" as never);
    cleanup();
  }
});

test("pinning never touches lifecycle: archived stays archived, state untouched", async () => {
  const { db, cleanup } = await freshServer("pin-orthogonal");
  const sessions = await import("../src/sessions.js");
  sessions.registerAdapter("fake-pin3" as never, fakeAdapter("fake-pin3"));
  try {
    const s = await sessions.createSession({ harness: "fake-pin3" as never, cwd: "/tmp" });
    sessions.setSessionArchived(s.id, true);
    (sessions as any).setSessionPinned(s.id, true);
    const row = db.store.listSessions().find((r: any) => r.id === s.id) as any;
    assert.equal(!!row.archived, true, "archived survives pinning");
    assert.equal(row.pinned, true);
    assert.ok(!["error", "closed"].includes(row.state), "pinning a live session doesn't change its state");

    assert.throws(() => (sessions as any).setSessionPinned("no-such-session", true), /no such session|unknown/i, "unknown id errors cleanly");
  } finally {
    sessions.unregisterAdapter("fake-pin3" as never);
    cleanup();
  }
});

/* regression (audit round 1, B1): pin must NOT bump updated_at — the row
   stays visible, so a bump would fake recency ("ago" jumps to now) and an
   unpin would strand the chat at the top of the unpinned partition */
test("pin/unpin leaves updated_at and the recency order untouched", async () => {
  const { db, cleanup } = await freshServer("pin-recency");
  const sessions = await import("../src/sessions.js");
  sessions.registerAdapter("fake-pin4" as never, fakeAdapter("fake-pin4"));
  try {
    const older = await sessions.createSession({ harness: "fake-pin4" as never, cwd: "/tmp", title: "older" });
    const newer = await sessions.createSession({ harness: "fake-pin4" as never, cwd: "/tmp", title: "newer" });
    db.store.run(`UPDATE sessions SET updated_at = ? WHERE id = ?`, 1000, older.id);
    db.store.run(`UPDATE sessions SET updated_at = ? WHERE id = ?`, 2000, newer.id);

    (sessions as any).setSessionPinned(older.id, true);
    (sessions as any).setSessionPinned(older.id, false);

    const row = db.store.listSessions().find((r: any) => r.id === older.id) as any;
    assert.equal(row.updated_at, 1000, "pin cycle never touches updated_at");
    /* the file shares one in-process db across tests, so assert the RELATIVE
       order of just these two rows, not the whole list */
    const mine = db.store
      .listSessions()
      .map((r: any) => r.id)
      .filter((id: string) => id === older.id || id === newer.id);
    assert.deepEqual(mine, [newer.id, older.id], "the unpinned recency order is exactly where it was");
  } finally {
    sessions.unregisterAdapter("fake-pin4" as never);
    cleanup();
  }
});
