import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyOutbox,
  enqueue,
  has,
  newOpId,
  OUTBOX_CAP,
  OUTBOX_MAX_AGE_MS,
  pending,
  retire,
  RETRY_NOTE,
  type OutboxState,
} from "../src/lib/outbox";

/* issue #216 — the client half of retry-safe sends. The outbox is the only
   thing that makes the server ledger reachable: an op id has to SURVIVE the
   lost ack, and has to be retirable on ack, or the dedupe is decoration.

   The state machine is pure, so these test it directly — no React, no fetch.
   The rules that matter:
     - an unacked op stays queued and replays with the SAME op id
     - an acked op never replays (otherwise we would resend real work)
     - a replay is MARKED, so the transcript can say "retried" truthfully
     - nothing queued grows without bound, and a stale op is abandoned
       rather than replayed past the server's own dedupe window */

const op = (over: Partial<Parameters<typeof enqueue>[1]> = {}) => ({
  opId: over.opId ?? "op-1",
  kind: over.kind ?? ("prompt" as const),
  sessionId: over.sessionId ?? "s1",
  body: over.body ?? { text: "hello" },
  ...(over.at !== undefined ? { at: over.at } : {}),
});

test("an enqueued op is queued until it is retired", () => {
  let s = enqueue(emptyOutbox, op());
  assert.equal(s.entries.length, 1);
  assert.equal(has(s, "op-1"), true);
  s = retire(s, "op-1");
  assert.equal(s.entries.length, 0);
  assert.equal(has(s, "op-1"), false);
});

test("retiring an unknown op is a no-op (and returns the same state)", () => {
  const s = enqueue(emptyOutbox, op());
  assert.equal(retire(s, "nope"), s, "identity, so the store never re-renders for nothing");
});

test("re-enqueueing the same op id replaces rather than duplicates", () => {
  let s = enqueue(emptyOutbox, op());
  s = enqueue(s, op({ body: { text: "changed" } }));
  assert.equal(s.entries.length, 1);
  assert.deepEqual(s.entries[0]!.body, { text: "changed" });
});

test("pending() replays unacked ops with the same op id and marks them", () => {
  const s = enqueue(emptyOutbox, op());
  const { replay, state } = pending(s, Date.now());
  assert.equal(replay.length, 1);
  assert.equal(replay[0]!.opId, "op-1", "same id — this is the whole mechanism");
  assert.equal(replay[0]!.replayed, true, "marked as a replay");
  assert.equal(replay[0]!.attempts, 2, "attempt count bumped");
  assert.equal(state.entries.length, 1, "still queued: it is not acked yet");
});

test("pending() abandons ops past the age cap instead of replaying them", () => {
  const then = Date.now() - OUTBOX_MAX_AGE_MS - 1000;
  const s = enqueue(emptyOutbox, op({ at: then }));
  const { replay, state } = pending(s, Date.now());
  assert.equal(replay.length, 0, "a stale replay would BE the duplicate we prevent");
  assert.equal(state.entries.length, 0, "and it is dropped, not left to grow");
});

test("an op just inside the age cap still replays", () => {
  const at = Date.now() - OUTBOX_MAX_AGE_MS + 5_000;
  const s = enqueue(emptyOutbox, op({ at }));
  const { replay } = pending(s, Date.now());
  assert.equal(replay.length, 1);
});

test("the queue is capped and drops the OLDEST entries", () => {
  let s: OutboxState = emptyOutbox;
  for (let i = 0; i < OUTBOX_CAP + 10; i++) s = enqueue(s, op({ opId: `op-${i}` }));
  assert.equal(s.entries.length, OUTBOX_CAP, "bounded");
  assert.equal(has(s, "op-0"), false, "the oldest went");
  assert.equal(has(s, `op-${OUTBOX_CAP + 9}`), true, "the newest stays");
});

test("kinds are carried through, so the replay fires the right call", () => {
  let s = emptyOutbox;
  s = enqueue(s, op({ opId: "p", kind: "prompt" }));
  s = enqueue(s, op({ opId: "i", kind: "interrupt", body: {} }));
  s = enqueue(s, op({ opId: "r", kind: "perm", body: { requestId: "req", choice: "allow" } }));
  const { replay } = pending(s);
  assert.deepEqual(
    replay.map((e) => e.kind).sort(),
    ["interrupt", "perm", "prompt"],
  );
  const perm = replay.find((e) => e.kind === "perm")!;
  assert.deepEqual(perm.body, { requestId: "req", choice: "allow" });
});

test("newOpId mints distinct ids", () => {
  const ids = new Set(Array.from({ length: 200 }, () => newOpId()));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.ok(id.length > 0 && id.length <= 200, "within the server's op-id bound");
});

test("a first send is never marked as a retry", () => {
  /* RETRY_NOTE is only reachable from a replay, and a replay only exists
     after pending() — this pins the marker to that path: a freshly enqueued
     op carries no replay flag. */
  const s = enqueue(emptyOutbox, op());
  assert.equal(s.entries[0]!.replayed, undefined);
  assert.equal(RETRY_NOTE, "Retried after reconnect");
});
