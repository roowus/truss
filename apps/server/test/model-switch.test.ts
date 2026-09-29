import { test } from "node:test";
import assert from "node:assert/strict";
import { freshServer, tick } from "./helpers.js";
import type { AdapterHandle, HarnessAdapter, SessionOpts } from "../src/adapters/types.js";
import type { ProtoEvent } from "@truss/proto";

/* sessions.switchModel — the chat header's model picker backend:
   live switch when the adapter supports it (pi set_model), graceful
   restart-with-history otherwise, store-only for dead sessions. */

interface FakeRec {
  spawnOpts: SessionOpts[];
  setModelCalls: { provider?: string; model: string }[];
  disposed: number;
  pushed: ProtoEvent[]; // events the harness itself emits
}

function fakeAdapter(id: string, rec: FakeRec, opts: { withSetModel?: boolean; ref?: string } = {}): HarnessAdapter {
  const adapter: HarnessAdapter = {
    id: id as never,
    capabilities: { permissions: false, subagents: false, streaming: true, queueWhileRunning: true },
    async listModels() {
      return [];
    },
    async spawn(so: SessionOpts): Promise<AdapterHandle> {
      rec.spawnOpts.push(so);
      return { sessionId: so.sessionId, harnessRef: opts.ref };
    },
    send() {},
    interrupt() {},
    async *events() {
      for (const ev of rec.pushed) yield ev;
      await new Promise(() => {});
      yield undefined as never;
    },
    dispose() {
      rec.disposed++;
    },
  };
  if (opts.withSetModel) {
    adapter.setModel = async (_h, provider, model) => {
      rec.setModelCalls.push({ provider, model });
    };
  }
  return adapter;
}

test("live mode: adapter.setModel is used, no respawn, row + event updated, transcript note", async () => {
  const { db, cleanup } = await freshServer("ms-live");
  const sessions = await import("../src/sessions.js");
  const rec: FakeRec = { spawnOpts: [], setModelCalls: [], disposed: 0, pushed: [] };
  sessions.registerAdapter("fake" as never, fakeAdapter("fake", rec, { withSetModel: true }));
  try {
    const s = await sessions.createSession({ harness: "fake" as never, cwd: "/tmp", model: "m1", provider: "p1" });
    const r = await sessions.switchModel(s.id, "m2", "p2");
    assert.equal(r.mode, "live");
    assert.deepEqual(rec.setModelCalls, [{ provider: "p2", model: "m2" }]);
    assert.equal(rec.spawnOpts.length, 1, "no respawn");
    assert.equal(rec.disposed, 0, "no dispose");

    const row = db.store.getSession(s.id)!;
    assert.equal(row.model, "m2");
    assert.equal(row.provider, "p2");

    const evs = db.store.listEvents(s.id).map((f) => f.ev);
    const upd = evs.find((e) => e.type === "session.updated") as { model?: string; provider?: string } | undefined;
    assert.equal(upd?.model, "m2");
    assert.equal(upd?.provider, "p2");
    const note = evs.find((e) => e.type === "msg.chunk" && String((e as { text?: string }).text).includes("model switched to p2/m2"));
    assert.ok(note, "system note in the transcript");
  } finally {
    sessions.unregisterAdapter("fake" as never);
    cleanup();
  }
});

test("restart mode: adapter without setModel respawns on the harness ref with the new pair", async () => {
  const { db, cleanup } = await freshServer("ms-restart");
  const sessions = await import("../src/sessions.js");
  const rec: FakeRec = { spawnOpts: [], setModelCalls: [], disposed: 0, pushed: [] };
  sessions.registerAdapter("fake" as never, fakeAdapter("fake", rec, { ref: "harness-ref-9" }));
  try {
    const s = await sessions.createSession({ harness: "fake" as never, cwd: "/tmp", model: "m1", provider: "p1" });
    db.store.setHarnessRef(s.id, "harness-ref-9");
    db.store.setSessionState(s.id, "idle");

    const r = await sessions.switchModel(s.id, "m2", "p2");
    assert.equal(r.mode, "restart");
    assert.equal(rec.disposed, 1, "old process disposed");
    assert.equal(rec.spawnOpts.length, 2, "respawned");
    assert.equal(rec.spawnOpts[1].model, "m2");
    assert.equal(rec.spawnOpts[1].provider, "p2");
    assert.equal(rec.spawnOpts[1].resumeRef, "harness-ref-9", "history kept via the harness's own session");

    const row = db.store.getSession(s.id)!;
    assert.equal(row.model, "m2");
    assert.equal(row.provider, "p2");

    /* a follow-up prompt goes to the NEW handle — the session is fully live again */
    await sessions.sendPrompt(s.id, "still alive");
    const evs = db.store.listEvents(s.id).map((f) => f.ev);
    assert.ok(evs.some((e) => e.type === "msg.chunk" && (e as { text?: string }).text === "still alive"));
  } finally {
    sessions.unregisterAdapter("fake" as never);
    cleanup();
  }
});

test("restart is refused while the session is running (would kill the turn)", async () => {
  const { db, cleanup } = await freshServer("ms-busy");
  const sessions = await import("../src/sessions.js");
  const rec: FakeRec = { spawnOpts: [], setModelCalls: [], disposed: 0, pushed: [] };
  sessions.registerAdapter("fake" as never, fakeAdapter("fake", rec));
  try {
    const s = await sessions.createSession({ harness: "fake" as never, cwd: "/tmp" });
    db.store.setSessionState(s.id, "running");
    await assert.rejects(() => sessions.switchModel(s.id, "m2"), /running/);
    assert.equal(rec.disposed, 0);
    assert.equal(rec.spawnOpts.length, 1);
    assert.equal(db.store.getSession(s.id)?.model, null, "row untouched on refusal");
  } finally {
    sessions.unregisterAdapter("fake" as never);
    cleanup();
  }
});

test("stored mode: dead session just records the pair; next resume uses it", async () => {
  const { db, cleanup } = await freshServer("ms-stored");
  const sessions = await import("../src/sessions.js");
  const rec: FakeRec = { spawnOpts: [], setModelCalls: [], disposed: 0, pushed: [] };
  sessions.registerAdapter("fake" as never, fakeAdapter("fake", rec, { ref: "ref-77" }));
  try {
    const s = await sessions.createSession({ harness: "fake" as never, cwd: "/tmp", model: "m1", provider: "p1" });
    db.store.setHarnessRef(s.id, "ref-77");
    sessions.closeSession(s.id);
    db.store.setSessionState(s.id, "closed");

    const r = await sessions.switchModel(s.id, "m2", "p2");
    assert.equal(r.mode, "stored");
    assert.equal(rec.spawnOpts.length, 1, "no respawn for a dead session");
    assert.equal(rec.disposed, 1, "closed once by closeSession");

    /* resume picks up the NEW provider+model (the original silent-400 regression) */
    await sessions.sendPrompt(s.id, "wake");
    assert.equal(rec.spawnOpts.length, 2, "resume respawned");
    assert.equal(rec.spawnOpts[1].model, "m2");
    assert.equal(rec.spawnOpts[1].provider, "p2");
    assert.equal(rec.spawnOpts[1].resumeRef, "ref-77");

    const note = db.store
      .listEvents(s.id)
      .map((f) => f.ev)
      .find((e) => e.type === "msg.chunk" && String((e as { text?: string }).text).includes("applies when the session resumes"));
    assert.ok(note, "note says it applies on resume");
  } finally {
    sessions.unregisterAdapter("fake" as never);
    cleanup();
  }
});

test("unknown session / empty model rejected", async () => {
  const { cleanup } = await freshServer("ms-invalid");
  const sessions = await import("../src/sessions.js");
  await assert.rejects(() => sessions.switchModel("nope", "m2"), /no such session/);
  const rec: FakeRec = { spawnOpts: [], setModelCalls: [], disposed: 0, pushed: [] };
  sessions.registerAdapter("fake" as never, fakeAdapter("fake", rec));
  try {
    const s = await sessions.createSession({ harness: "fake" as never, cwd: "/tmp" });
    await assert.rejects(() => sessions.switchModel(s.id, ""), /model is required/);
  } finally {
    sessions.unregisterAdapter("fake" as never);
    cleanup();
  }
});

test("switch without provider keeps the pair consistent (provider cleared, not stale)", async () => {
  const { db, cleanup } = await freshServer("ms-noprovider");
  const sessions = await import("../src/sessions.js");
  const rec: FakeRec = { spawnOpts: [], setModelCalls: [], disposed: 0, pushed: [] };
  sessions.registerAdapter("fake" as never, fakeAdapter("fake", rec, { withSetModel: true }));
  try {
    const s = await sessions.createSession({ harness: "fake" as never, cwd: "/tmp", model: "m1", provider: "p1" });
    await sessions.switchModel(s.id, "m2");
    const row = db.store.getSession(s.id)!;
    assert.equal(row.model, "m2");
    assert.equal(row.provider, null, "no stale provider left pointing at the old endpoint");
    await tick();
  } finally {
    sessions.unregisterAdapter("fake" as never);
    cleanup();
  }
});
