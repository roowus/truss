import { test } from "node:test";
import assert from "node:assert/strict";
import { freshServer } from "./helpers.js";
import type { AdapterHandle, HarnessAdapter, SessionOpts } from "../src/adapters/types.js";

/* SPEC-TESTS for a reasoning-effort changer in chats —
   https://github.com/roowus/truss/issues/27
   ("Add effort changer in chats"). These pin the contract the implementation
   satisfies.

   The session row stores model + provider as a pair (the "never split them"
   migration). Effort joins that pair: it's per-session state that must
   travel through create, live-switch, and resume exactly like model does.

   The contract:

   - SessionOpts carries effort?: string | null; createSession forwards it to
     adapter.spawn AND persists it on the session row;
   - sessions.setSessionEffort(id, effort) — mirrors switchModel: live
     session → respawn carrying the new effort (restart mode); not-live →
     stored, applied at next resume; either way the row updates and a
     session.updated broadcast tells clients;
   - resumeSession carries effort with model+provider (the triple never
     splits);
   - normalizeEffort(v): "High" → "high", whitespace/empty/null → null
     (cleared), unknown levels pass through (harnesses differ);

   Adapter wiring for the remaining harnesses (dsh config-option / hermes
   reasoning config / claude thinking budget) is acceptance criteria,
   not here. */

interface FakeRec {
  spawnOpts: SessionOpts[];
  /** when set, the next spawn rejects (the failed-respawn path) */
  failSpawn?: boolean;
}

function fakeAdapter(id: string, rec: FakeRec): HarnessAdapter {
  return {
    id: id as never,
    capabilities: { permissions: false, subagents: false, streaming: true, queueWhileRunning: true },
    async listModels() {
      return [];
    },
    async spawn(opts: SessionOpts): Promise<AdapterHandle> {
      if (rec.failSpawn) throw new Error("spawn blew up");
      rec.spawnOpts.push(opts);
      return { sessionId: opts.sessionId, harnessRef: `ref-${opts.sessionId}` };
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

async function setup(tag: string) {
  const { db, cleanup } = await freshServer(tag);
  const sessions = await import("../src/sessions.js");
  const rec: FakeRec = { spawnOpts: [] };
  sessions.registerAdapter("fake-effort" as never, fakeAdapter("fake-effort", rec));
  const mk = (extra: Record<string, unknown> = {}) =>
    (sessions.createSession as any)({ harness: "fake-effort", cwd: "/tmp", ...extra });
  return { db, sessions, rec, mk, cleanup: () => { sessions.unregisterAdapter("fake-effort" as never); cleanup(); } };
}

test("createSession forwards effort to the adapter spawn and persists it on the row", async () => {
  const { db, rec, mk, cleanup } = await setup("effort-create");
  try {
    const s = await mk({ effort: "high" });
    assert.equal(rec.spawnOpts.length, 1);
    assert.equal(
      (rec.spawnOpts[0] as any).effort,
      "high",
      "effort must reach the harness, not just the row",
    );
    assert.equal((db.store.getSession(s.id) as any).effort, "high", "effort persists on the session row (a new column, like provider)");
  } finally {
    cleanup();
  }
});

test("setSessionEffort on a live session: respawn carries the new effort; row + broadcast update", async () => {
  const { db, sessions, rec, mk, cleanup } = await setup("effort-switch");
  try {
    assert.equal(typeof (sessions as any).setSessionEffort, "function", "sessions.ts must export setSessionEffort(id, effort) — see issue #27");
    const frames: string[] = [];
    sessions.setBroadcaster((f) => {
      if (f.ev.type === "session.updated") frames.push((f.ev as any).sessionId);
    });
    try {
      const s = await mk({ effort: "low" });
      await (sessions as any).setSessionEffort(s.id, "high");
      assert.equal(rec.spawnOpts.length, 2, "live switch = restart (no live effort hook today)");
      assert.equal((rec.spawnOpts[1] as any).effort, "high", "the respawn carries the new effort");
      assert.equal((db.store.getSession(s.id) as any).effort, "high", "row updated");
      assert.ok(frames.includes(s.id), "session.updated broadcast so the header chip refreshes");
    } finally {
      sessions.setBroadcaster(() => {});
    }
  } finally {
    cleanup();
  }
});

test("effort survives resume: the model+provider+effort triple never splits", async () => {
  const { db, sessions, rec, mk, cleanup } = await setup("effort-resume");
  try {
    const s = await mk({ effort: "max" });
    db.store.setHarnessRef(s.id, "ref-1");
    sessions.closeSession(s.id);
    db.store.setSessionState(s.id, "closed");

    const ok = await sessions.resumeSession(s.id);
    assert.equal(ok, true);
    assert.equal(rec.spawnOpts.length, 2, "respawned from the stored ref");
    assert.equal((rec.spawnOpts[1] as any).effort, "max", "resume carries effort — a model-only resume silently reverts effort");
  } finally {
    cleanup();
  }
});

test("switchModel's restart path carries the stored effort (the triple never splits)", async () => {
  const { db, sessions, rec, mk, cleanup } = await setup("effort-model-switch");
  try {
    const s = await mk({ effort: "high" });
    /* the fake has no setModel, so switchModel takes the dispose+respawn path */
    await (sessions as any).switchModel(s.id, "m2", "p2");
    assert.equal(rec.spawnOpts.length, 2, "restart mode: dispose + respawn");
    assert.equal((rec.spawnOpts[1] as any).model, "m2");
    assert.equal((rec.spawnOpts[1] as any).effort, "high", "a model switch must not silently revert effort (issue #27 criterion 2)");
    assert.equal((db.store.getSession(s.id) as any).effort, "high", "row effort untouched by the model switch");
  } finally {
    cleanup();
  }
});

test("a failed respawn marks the session error instead of leaving it dead but idle", async () => {
  const { db, sessions, rec, mk, cleanup } = await setup("effort-respawn-fail");
  try {
    const states: string[] = [];
    sessions.setBroadcaster((f: any) => {
      if (f.ev.type === "session.state") states.push(f.ev.state);
    });
    try {
      const s = await mk({ effort: "low" });
      rec.failSpawn = true;
      await assert.rejects(() => (sessions as any).setSessionEffort(s.id, "high"), /blew up/);
      assert.equal(db.store.getSession(s.id)!.state, "error", "the session is out of `live` and can't take prompts, so the row must say error");
      assert.ok(states.includes("error"), "session.state error so the UI tells the truth");
      assert.equal((db.store.getSession(s.id) as any).effort, "low", "the failed switch left the stored effort untouched");
    } finally {
      sessions.setBroadcaster(() => {});
    }
  } finally {
    cleanup();
  }
});

test("setSessionEffort on a non-live session stores it for next spawn (no respawn)", async () => {
  const { db, sessions, rec, mk, cleanup } = await setup("effort-stored");
  try {
    assert.equal(typeof (sessions as any).setSessionEffort, "function", "setSessionEffort must exist (see switch test)");
    const s = await mk();
    sessions.closeSession(s.id);
    db.store.setSessionState(s.id, "closed");
    await (sessions as any).setSessionEffort(s.id, "medium");
    assert.equal(rec.spawnOpts.length, 1, "no respawn for a closed session");
    assert.equal((db.store.getSession(s.id) as any).effort, "medium", "stored for the next resume");
  } finally {
    cleanup();
  }
});

test("normalizeEffort: case-insensitive, blank clears, unknown levels pass through", async () => {
  const { sessions, cleanup } = await setup("effort-normalize");
  try {
    const norm = (sessions as any).normalizeEffort;
    assert.equal(typeof norm, "function", "sessions.ts (or lib) must export normalizeEffort — see issue #27");
    assert.equal(norm("High"), "high");
    assert.equal(norm("  low "), "low");
    assert.equal(norm(""), null, "empty clears the override (harness default)");
    assert.equal(norm("   "), null);
    assert.equal(norm(null), null);
    assert.equal(norm(undefined), null);
    assert.equal(norm("ultrathink"), "ultrathink", "harness-specific levels pass through untouched");
  } finally {
    cleanup();
  }
});
