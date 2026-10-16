import { test } from "node:test";
import assert from "node:assert/strict";
import { freshServer, tick } from "./helpers.js";
import type { AdapterHandle, HarnessAdapter, SessionOpts } from "../src/adapters/types.js";
import type { ProtoEvent } from "@truss/proto";

/* issue #216 — the op ledger: a retried send must not become a second turn.

   Same fake-adapter rig as sessions.test.ts: a real (temp) SQLite store and a
   harness that records what it was actually asked to send, so "one turn" and
   "two turns" are observed at the boundary that matters (adapter.send calls
   and the persisted user bubbles), not inferred. */

interface FakeRec {
  sent: string[];
  interrupts: number;
  resolved: { requestId: string; choice: string }[];
  events: ProtoEvent[];
  /** make the adapter's mutations throw (audit B3: a refused adapter call
      must not burn the op id) */
  throwOnSend?: boolean;
  throwOnInterrupt?: boolean;
  throwOnResolve?: boolean;
  /** gate every spawn so a test can hold the resume open and force the
      concurrent-retry race (audit B2) */
  spawnGate?: Promise<void>;
  /** how many spawns have happened (the first is create, the rest resume) */
  spawns: number;
}

function fakeAdapter(id: string, rec: FakeRec): HarnessAdapter {
  return {
    id: id as never,
    capabilities: { permissions: true, subagents: false, streaming: true, queueWhileRunning: true },
    async listModels() {
      return [];
    },
    async spawn(opts: SessionOpts): Promise<AdapterHandle> {
      /* the gate holds the RESUME open, so a test can park two callers
         inside sendPrompt's await (the B2 race window) */
      if (rec.spawnGate && rec.spawns++ > 0) await rec.spawnGate;
      return { sessionId: opts.sessionId };
    },
    send(_h: AdapterHandle, text: string) {
      if (rec.throwOnSend) throw new Error("adapter refused the send");
      rec.sent.push(text);
    },
    interrupt() {
      if (rec.throwOnInterrupt) throw new Error("adapter refused the interrupt");
      rec.interrupts++;
    },
    resolve(_h: AdapterHandle, requestId: string, choice: string) {
      if (rec.throwOnResolve) throw new Error("adapter refused the resolve");
      rec.resolved.push({ requestId, choice });
    },
    async *events() {
      await new Promise(() => {});
      yield undefined as never;
    },
    dispose() {},
  };
}

/** boot a session on the fake harness and return the rig */
async function rig(tag: string) {
  const { db, cleanup } = await freshServer(tag);
  const sessions = await import("../src/sessions.js");
  const rec: FakeRec = { sent: [], interrupts: 0, resolved: [], events: [], spawns: 0 };
  sessions.registerAdapter("fake" as never, fakeAdapter("fake", rec));
  const s = await sessions.createSession({ harness: "fake" as never, cwd: "/tmp" });
  /* capture the event bus without a websocket */
  sessions.setBroadcaster((f) => rec.events.push(f.ev));
  return { db, sessions, rec, session: s, cleanup };
}

/**
 * A session that is NOT live but IS resumable — the state in which
 * sendPrompt awaits `resumeLiveSession` (audit B2: that await is the window
 * two same-op-id retries both pass the "unseen" check in).
 *
 * `spawnGate` delays only the RESUME spawn (the first is the create).
 */
async function rigDead(tag: string, spawnGate?: Promise<void>) {
  const { db, cleanup } = await freshServer(tag);
  const sessions = await import("../src/sessions.js");
  const rec: FakeRec = { sent: [], interrupts: 0, resolved: [], events: [], spawnGate, spawns: 0 };
  sessions.registerAdapter("fake" as never, fakeAdapter("fake", rec));
  const s = await sessions.createSession({ harness: "fake" as never, cwd: "/tmp" });
  /* a real dead-but-resumable session carries the harness's own ref — that
     is what resumeLiveSession spawns on — so set it, then take it down */
  db.store.setHarnessRef(s.id, "ref-dead");
  await sessions.closeSession(s.id);
  sessions.setBroadcaster((f) => rec.events.push(f.ev));
  return { db, sessions, rec, session: s, cleanup };
}

/** user bubbles persisted for a session */
function userBubbles(db: { store: { listEvents: (id: string) => { ev: ProtoEvent }[] } }, id: string) {
  return db.store
    .listEvents(id)
    .map((f) => f.ev)
    .filter((ev) => ev.type === "msg.start" && ev.role === "user");
}

test("#216: the same op id twice is ONE turn and two identical acks", async () => {
  const { db, sessions, rec, session, cleanup } = await rig("op-dup");
  try {
    const a = await sessions.sendPrompt(session.id, "hello", undefined, "op-1");
    const b = await sessions.sendPrompt(session.id, "hello", undefined, "op-1");

    /* the harness saw the text once */
    assert.equal(rec.sent.length, 1, "adapter.send ran once");
    assert.equal(userBubbles(db, session.id).length, 1, "one user bubble");

    /* both acks agree, and the replay says so */
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(b.messageId, a.messageId, "replay returns the original messageId");
    assert.equal(b.clientOpId, "op-1");
    assert.equal(a.deduped, undefined);
    assert.equal(b.deduped, true);
  } finally {
    cleanup();
  }
});

test("#216: different op ids are not deduped — two turns", async () => {
  const { db, sessions, rec, session, cleanup } = await rig("op-distinct");
  try {
    const a = await sessions.sendPrompt(session.id, "hello", undefined, "op-a");
    const b = await sessions.sendPrompt(session.id, "hello", undefined, "op-b");
    assert.equal(rec.sent.length, 2, "adapter.send ran twice");
    assert.equal(userBubbles(db, session.id).length, 2, "two user bubbles");
    assert.notEqual(a.messageId, b.messageId);
  } finally {
    cleanup();
  }
});

test("#216: no op id behaves exactly as before (back-compat)", async () => {
  const { db, sessions, rec, session, cleanup } = await rig("op-none");
  try {
    const a = await sessions.sendPrompt(session.id, "hello");
    const b = await sessions.sendPrompt(session.id, "hello");
    assert.equal(rec.sent.length, 2, "undeduped without an op id");
    assert.equal(userBubbles(db, session.id).length, 2);
    assert.equal(a.clientOpId, undefined);
    assert.equal(b.deduped, undefined);
  } finally {
    cleanup();
  }
});

test("#216: malformed op ids are ignored, not rejected", async () => {
  const { sessions, rec, session, cleanup } = await rig("op-bad");
  try {
    /* empty / whitespace / oversized / non-string: dedupe is skipped, the
       send still happens, and nothing new throws (no new failure mode) */
    await sessions.sendPrompt(session.id, "a", undefined, "");
    await sessions.sendPrompt(session.id, "b", undefined, "   ");
    await sessions.sendPrompt(session.id, "c", undefined, "x".repeat(201));
    await sessions.sendPrompt(session.id, "d", undefined, undefined);
    assert.equal(rec.sent.length, 4);
  } finally {
    cleanup();
  }
});

test("#216: a refused send does not burn the op id", async () => {
  const { sessions, rec, session, cleanup } = await rig("op-refuse");
  try {
    /* make the adapter refuse, like a dead harness */
    const adapter = rec as unknown as { sent: string[] };
    void adapter;
    const orig = rec.sent.push.bind(rec.sent);
    rec.sent.push = () => {
      throw new Error("harness gone");
    };
    await assert.rejects(() => sessions.sendPrompt(session.id, "boom", undefined, "op-x"));
    rec.sent.push = orig;

    /* the retry of the SAME op id must really dispatch, not replay a success */
    const retry = await sessions.sendPrompt(session.id, "boom", undefined, "op-x");
    assert.equal(retry.deduped, undefined, "retry dispatched for real");
    assert.equal(rec.sent.length, 1, "the retry reached the harness");
  } finally {
    cleanup();
  }
});

test("#216: interrupt dedupes on the same op id", async () => {
  const { sessions, rec, session, cleanup } = await rig("op-int");
  try {
    const a = sessions.interrupt(session.id, "int-1");
    const b = sessions.interrupt(session.id, "int-1");
    assert.equal(rec.interrupts, 1, "adapter.interrupt ran once");
    assert.equal(a.deduped, undefined);
    assert.equal(b.deduped, true);
    assert.equal(b.clientOpId, "int-1");

    /* a different op id is a real second interrupt */
    sessions.interrupt(session.id, "int-2");
    assert.equal(rec.interrupts, 2);
  } finally {
    cleanup();
  }
});

test("#216: permission resolve dedupes on the same op id", async () => {
  const { sessions, rec, session, cleanup } = await rig("op-perm");
  try {
    const a = sessions.resolvePermission(session.id, "req-1", "allow", "perm-1");
    const b = sessions.resolvePermission(session.id, "req-1", "allow", "perm-1");
    assert.equal(rec.resolved.length, 1, "adapter.resolve ran once");
    assert.equal(a.deduped, undefined);
    assert.equal(b.deduped, true);

    sessions.resolvePermission(session.id, "req-1", "deny", "perm-2");
    assert.equal(rec.resolved.length, 2, "a new op id still resolves");
    /* the perm.resolve frame was emitted once per real resolve */
    const frames = rec.events.filter((e) => e.type === "perm.resolve");
    assert.equal(frames.length, 2);
  } finally {
    cleanup();
  }
});

test("#216: a failed interrupt does not burn the op id", async () => {
  const { sessions, rec, cleanup } = await rig("op-int-fail");
  try {
    assert.throws(() => sessions.interrupt("no-such-live-session", "int-fail"));
    /* the ledger must not have kept the claim: a later real interrupt with
       the same id (once the session is live) is not swallowed */
    assert.equal(rec.interrupts, 0);
  } finally {
    cleanup();
  }
});

test("#216: ledger entries expire on the TTL", async () => {
  const { db, sessions, rec, session, cleanup } = await rig("op-ttl");
  try {
    await sessions.sendPrompt(session.id, "hello", undefined, "op-ttl");
    /* still replayable */
    const before = await sessions.sendPrompt(session.id, "hello", undefined, "op-ttl");
    assert.equal(before.deduped, true);

    /* sweep as if a day and a minute had passed. `freshServer` reuses one
       module-level db across this file's tests, so assert on THIS op rather
       than an absolute row count. */
    const removed = sessions.sweepOpLedger(Date.now() + sessions.OP_TTL_MS + 60_000);
    assert.ok(removed >= 1, "at least the expired row went");
    assert.equal(db.store.getOp(session.id, "prompt", "op-ttl"), undefined, "op-ttl is gone");

    /* and now the same op id is a fresh turn again */
    const after = await sessions.sendPrompt(session.id, "hello", undefined, "op-ttl");
    assert.equal(after.deduped, undefined);
    assert.equal(rec.sent.length, 2);
  } finally {
    cleanup();
  }
});

test("#216: the per-session cap evicts the OLDEST ops", async () => {
  const { db, sessions, rec, session, cleanup } = await rig("op-cap");
  try {
    const cap = sessions.OP_CAP_PER_SESSION;
    for (let i = 0; i < cap + 5; i++) {
      await sessions.sendPrompt(session.id, `m${i}`, undefined, `op-${i}`);
      /* distinct millisecond stamps so "oldest" is unambiguous */
      await tick(2);
    }
    /* the first five are gone: replaying op-0 dispatches again */
    const evicted = await sessions.sendPrompt(session.id, "replay", undefined, "op-0");
    assert.equal(evicted.deduped, undefined, "op-0 was evicted");
    /* the newest is still recorded */
    const kept = await sessions.sendPrompt(session.id, "m", undefined, `op-${cap + 4}`);
    assert.equal(kept.deduped, true, "the newest op is still deduped");
    assert.ok(rec.sent.length > cap, "sends kept flowing");

    /* and the table is actually bounded */
    const rows = db.store.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM op_ledger WHERE session_id = ? AND op_kind = 'prompt'`,
      session.id,
    );
    assert.ok((rows?.n ?? 0) <= cap, `ledger bounded to ${cap}, saw ${rows?.n}`);
  } finally {
    cleanup();
  }
});

test("#216: a live session serializes two same-op-id sends (no race window)", async () => {
  const { db, sessions, rec, session, cleanup } = await rig("op-race-live");
  try {
    await Promise.all([
      sessions.sendPrompt(session.id, "race", undefined, "op-race"),
      sessions.sendPrompt(session.id, "race", undefined, "op-race"),
    ]);
    assert.equal(rec.sent.length, 1, "only one dispatch");
    assert.equal(userBubbles(db, session.id).length, 1, "only one bubble");
  } finally {
    cleanup();
  }
});

test("#216: the resume await does not let two same-op-id retries double-dispatch", async () => {
  /* audit B2: this is the case the live-session test above does NOT cover.
     The session is closed-but-resumable, so sendPrompt awaits the resume
     between its "unseen" check and its dispatch — both callers can be inside
     that window at once. The claim must be atomic and must happen after the
     await, or both dispatch and the transcript gets two turns. */
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { db, sessions, rec, session, cleanup } = await rigDead("op-race-dead", gate);
  try {
    /* both calls park inside the shared resume attempt */
    const a = sessions.sendPrompt(session.id, "race", undefined, "op-race-dead");
    const b = sessions.sendPrompt(session.id, "race", undefined, "op-race-dead");
    await tick(10);
    release();
    const [ra, rb] = await Promise.all([a, b]);

    assert.equal(rec.sent.length, 1, "the harness got the prompt exactly once");
    assert.equal(userBubbles(db, session.id).length, 1, "exactly one user bubble");

    /* one dispatched, the other replayed the winner's messageId */
    const deduped = [ra, rb].filter((r) => r.deduped);
    assert.equal(deduped.length, 1, "exactly one call is a deduped replay");
    assert.equal(ra.messageId, rb.messageId, "both acks name the same message");
  } finally {
    cleanup();
  }
});

test("#216: a throwing adapter does not burn the op id (send, interrupt, resolve)", async () => {
  const { sessions, rec, session, cleanup } = await rig("op-throws");
  try {
    /* --- prompt --- */
    rec.throwOnSend = true;
    await assert.rejects(() => sessions.sendPrompt(session.id, "boom", undefined, "op-s"));
    rec.throwOnSend = false;
    const s2 = await sessions.sendPrompt(session.id, "boom", undefined, "op-s");
    assert.equal(s2.deduped, undefined, "prompt retry really dispatched");
    assert.equal(rec.sent.length, 1, "the retry reached the harness");

    /* --- interrupt (audit B3) --- */
    rec.throwOnInterrupt = true;
    assert.throws(() => sessions.interrupt(session.id, "op-i"));
    rec.throwOnInterrupt = false;
    const i2 = sessions.interrupt(session.id, "op-i");
    assert.equal(i2.deduped, undefined, "interrupt retry is not swallowed as deduped");
    assert.equal(rec.interrupts, 1, "the retry really interrupted");

    /* --- permission resolve (audit B3) --- */
    rec.throwOnResolve = true;
    assert.throws(() => sessions.resolvePermission(session.id, "req-1", "allow", "op-p"));
    rec.throwOnResolve = false;
    const p2 = sessions.resolvePermission(session.id, "req-1", "allow", "op-p");
    assert.equal(p2.deduped, undefined, "resolve retry is not swallowed as deduped");
    assert.equal(rec.resolved.length, 1, "the retry really resolved the card");
  } finally {
    cleanup();
  }
});

test("#216: a refused interrupt leaves the op id free even when the session is not live", async () => {
  const { sessions, rec, cleanup } = await rigDead("op-int-nolive");
  try {
    assert.throws(() => sessions.interrupt("missing-session", "op-x"));
    assert.equal(rec.interrupts, 0);
  } finally {
    cleanup();
  }
});

test("#216/B2: the user msg.start frame carries the op id (the secondary ack)", async () => {
  /* the HTTP reply can be the thing that was lost; the frame proves the
     server acted, so it must carry the same key the client queued */
  const { sessions, rec, session, cleanup } = await rig("op-frame");
  try {
    await sessions.sendPrompt(session.id, "hello", undefined, "op-frame");
    const start = rec.events.find((e) => e.type === "msg.start" && e.role === "user") as
      | { clientOpId?: string; messageId: string }
      | undefined;
    assert.ok(start, "the user bubble was emitted");
    assert.equal(start!.clientOpId, "op-frame", "the frame names the op");

    /* and an op-id-less send emits no such field (back-compat) */
    rec.events.length = 0;
    await sessions.sendPrompt(session.id, "legacy");
    const legacy = rec.events.find((e) => e.type === "msg.start" && e.role === "user") as
      | { clientOpId?: string }
      | undefined;
    assert.equal(legacy?.clientOpId, undefined, "no key without an op id");
  } finally {
    cleanup();
  }
});

test("#216/B2: a replayed prompt does NOT emit a duplicate user bubble", async () => {
  const { sessions, rec, session, cleanup } = await rig("op-frame-dedupe");
  try {
    await sessions.sendPrompt(session.id, "hello", undefined, "op-x");
    rec.events.length = 0;
    const replay = await sessions.sendPrompt(session.id, "hello", undefined, "op-x");
    assert.equal(replay.deduped, true);
    assert.equal(
      rec.events.filter((e) => e.type === "msg.start" && e.role === "user").length,
      0,
      "a replay emits no second bubble frame",
    );
  } finally {
    cleanup();
  }
});
