import { test } from "node:test";
import assert from "node:assert/strict";
import { freshServer } from "./helpers.js";

/* db.ts — the store under everything. Covers the sessions table incl. the
   provider column (regression: resume used to lose provider and send a
   fireworks model id to the default zai endpoint -> 400 Unknown Model). */

test("sessions: create returns the row and lists it", async () => {
  const { db, cleanup } = await freshServer("db-basic");
  const row = db.store.createSession({
    id: "s1",
    harness: "pi",
    title: "new session",
    cwd: "/tmp",
    model: "glm-4.7",
    provider: "zai-local",
  });
  assert.equal(row.id, "s1");
  assert.equal(row.model, "glm-4.7");
  assert.equal(row.provider, "zai-local");
  assert.equal(row.state, "spawning");
  const list = db.store.listSessions();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "s1");
  cleanup();
});

test("sessions: provider persists round-trip (resume regression)", async () => {
  const { db, cleanup } = await freshServer("db-provider");
  db.store.createSession({
    id: "s2",
    harness: "pi",
    title: "t",
    cwd: "/tmp",
    model: "accounts/fireworks/models/kimi-k3",
    provider: "truss-fw",
  });
  const got = db.store.getSession("s2");
  assert.equal(got?.provider, "truss-fw");
  assert.equal(got?.model, "accounts/fireworks/models/kimi-k3");
  cleanup();
});

test("sessions: provider and model may be absent", async () => {
  const { db, cleanup } = await freshServer("db-nomodel");
  db.store.createSession({ id: "s3", harness: "dsh", title: "t", cwd: "/tmp" });
  const got = db.store.getSession("s3");
  assert.equal(got?.model, null);
  assert.equal(got?.provider, null);
  cleanup();
});

test("sessions: state, title, harness_ref updates", async () => {
  const { db, cleanup } = await freshServer("db-updates");
  db.store.createSession({ id: "s4", harness: "pi", title: "new session", cwd: "/tmp" });
  db.store.setSessionState("s4", "idle");
  assert.equal(db.store.getSession("s4")?.state, "idle");
  db.store.setSessionTitle("s4", "renamed");
  assert.equal(db.store.getSession("s4")?.title, "renamed");
  db.store.setHarnessRef("s4", "pi-session-abc");
  assert.equal(db.store.getSession("s4")?.harness_ref, "pi-session-abc");
  cleanup();
});

test("sessions: archive hides without deleting", async () => {
  const { db, cleanup } = await freshServer("db-archive");
  db.store.createSession({ id: "s5", harness: "pi", title: "t", cwd: "/tmp" });
  assert.equal(db.store.getSession("s5")?.archived, 0);
  db.store.setArchived("s5", true);
  assert.equal(db.store.getSession("s5")?.archived, 1);
  db.store.setArchived("s5", false);
  assert.equal(db.store.getSession("s5")?.archived, 0);
  cleanup();
});

test("events: append and replay in order", async () => {
  const { db, cleanup } = await freshServer("db-events");
  db.store.createSession({ id: "s6", harness: "pi", title: "t", cwd: "/tmp" });
  const at = Date.now();
  db.store.appendEvent({ type: "msg.start", sessionId: "s6", messageId: "m1", role: "user", at } as never);
  db.store.appendEvent({ type: "msg.chunk", sessionId: "s6", messageId: "m1", text: "hello" } as never);
  db.store.appendEvent({ type: "msg.done", sessionId: "s6", messageId: "m1" } as never);
  const events = db.store.listEvents("s6");
  assert.equal(events.length, 3);
  assert.equal(events[0].ev.type, "msg.start");
  assert.equal(events[1].ev.type, "msg.chunk");
  assert.equal((events[1].ev as { text: string }).text, "hello");
  assert.equal(events[2].ev.type, "msg.done");
  /* issue #142 audit: a payload with no `at` of its own (rows persisted
     before the sink stamped it, old importer output) replays with the
     row's wall-clock — never time-less, so a hydrated done-span cannot
     collapse to a fabricated 0ms */
  assert.equal((events[0].ev as { at: number }).at, at, "a stamped payload keeps its own time");
  const doneAt = (events[2].ev as { at?: number }).at;
  assert.ok(typeof doneAt === "number" && doneAt >= at, "an unstamped payload inherits the row time");
  cleanup();
});

test("events: the row-at fallback skips imported dsh logs (issue #142 audit, B9)", async () => {
  const { db, cleanup } = await freshServer("db-import-at");
  const T = 1_700_000_000_000; // the record's real moment, long before "now"
  db.store.createSession({ id: "dsh-deadbeef", harness: "dsh" as never, title: "t", cwd: "/tmp" });
  /* the pre-upgrade importer appended the whole rebuilt log in one batch:
     msg.start stamped with the record time, the done unstamped — and every
     row sharing the import instant. Appending the done on a later tick
     reproduces that shape (row time ≠ event time). */
  db.store.appendEvent({ type: "msg.start", sessionId: "dsh-deadbeef", messageId: "m1", role: "assistant", at: T } as never);
  await new Promise((r) => setTimeout(r, 5));
  db.store.appendEvent({ type: "msg.done", sessionId: "dsh-deadbeef", messageId: "m1" } as never);
  const imported = db.store.listEvents("dsh-deadbeef");
  assert.equal(
    (imported[1].ev as { at?: number }).at,
    undefined,
    "an imported done stays timeless — injecting the row time would fabricate a span as long as the session's age; the client replay clock bounds it instead",
  );

  /* the same shape on a sink-produced session still gets the repair:
     there the row time IS the event time */
  db.store.createSession({ id: "s-live", harness: "pi", title: "t", cwd: "/tmp" });
  db.store.appendEvent({ type: "msg.start", sessionId: "s-live", messageId: "m1", role: "assistant", at: T } as never);
  await new Promise((r) => setTimeout(r, 5));
  db.store.appendEvent({ type: "msg.done", sessionId: "s-live", messageId: "m1" } as never);
  const live = db.store.listEvents("s-live");
  const liveDoneAt = (live[1].ev as { at?: number }).at;
  assert.ok(typeof liveDoneAt === "number" && liveDoneAt > T, "a pre-upgrade sink row inherits its real insert time");
  cleanup();
});

test("events: deleting a session cascades its events", async () => {
  const { db, cleanup } = await freshServer("db-cascade");
  db.store.createSession({ id: "s7", harness: "pi", title: "t", cwd: "/tmp" });
  db.store.appendEvent({ type: "session.state", sessionId: "s7", state: "idle" } as never);
  assert.equal(db.store.listEvents("s7").length, 1);
  db.store.deleteSession("s7");
  assert.equal(db.store.getSession("s7"), undefined);
  assert.equal(db.store.listEvents("s7").length, 0);
  cleanup();
});

test("kv: set/get round-trip and overwrite", async () => {
  const { db, cleanup } = await freshServer("db-kv");
  db.store.setKv("layout", JSON.stringify({ a: 1 }));
  assert.deepEqual(JSON.parse(db.store.getKv("layout")!), { a: 1 });
  db.store.setKv("layout", JSON.stringify({ a: 2 }));
  assert.equal(JSON.parse(db.store.getKv("layout")!).a, 2);
  assert.equal(db.store.getKv("missing"), undefined);
  cleanup();
});

test("migrations: reopening the same dir is idempotent", async () => {
  const { dir, cleanup } = await freshServer("db-migrate");
  // second import against the same dir must not throw (columns already exist)
  delete (process.env as Record<string, string | undefined>).TRUSS_DATA_DIR;
  process.env.TRUSS_DATA_DIR = dir;
  const again = await import("../src/db.js");
  again.store.createSession({ id: "s8", harness: "pi", title: "t", cwd: "/tmp", provider: "p" });
  assert.equal(again.store.getSession("s8")?.provider, "p");
  cleanup();
});

test("sessions: setSessionModel moves model+provider as a pair (and clears)", async () => {
  const { db, cleanup } = await freshServer("db-model");
  db.store.createSession({ id: "s9", harness: "pi", title: "t", cwd: "/tmp", model: "m1", provider: "p1" });
  db.store.setSessionModel("s9", "m2", "p2");
  let got = db.store.getSession("s9");
  assert.equal(got?.model, "m2");
  assert.equal(got?.provider, "p2");
  db.store.setSessionModel("s9", "m3", null);
  got = db.store.getSession("s9");
  assert.equal(got?.model, "m3");
  assert.equal(got?.provider, null, "provider cleared, never stale");
  cleanup();
});
