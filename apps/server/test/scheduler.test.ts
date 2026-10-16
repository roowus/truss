import { after } from "node:test";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshServer, tick } from "./helpers.js";
import type { AdapterHandle, HarnessAdapter, SessionOpts } from "../src/adapters/types.js";

/* scheduler.ts + the task schedule columns (issue #16). runTask would spawn
   a real harness; fake adapters stand in (same trick as tasks.test.ts).
   NOTE: the db module is process-cached, so every test shares one store —
   each wipes the tasks + feed tables to stay isolated. */

const fakeHome = mkdtempSync(join(tmpdir(), "truss-test-sched-home-"));
process.env.HOME = fakeHome;
after(() => rmSync(fakeHome, { recursive: true, force: true }));

type Tasks = typeof import("../src/tasks.js");
type Db = typeof import("../src/db.js");
type Feed = typeof import("../src/feed.js");

function wipe(tasks: Tasks, db: Db, feed: Feed) {
  tasks.listTasks(); // ensures the table exists
  db.store.run("DELETE FROM tasks");
  feed.listFeed({}); // ensures feed_items exists
  db.store.run("DELETE FROM feed_items");
}

function fakeAdapter(rec: { spawnOpts: SessionOpts[]; sent: string[] }): HarnessAdapter {
  return {
    id: "fake" as never,
    capabilities: { permissions: false, subagents: false, streaming: true, queueWhileRunning: true },
    async listModels() {
      return [];
    },
    async spawn(opts: SessionOpts): Promise<AdapterHandle> {
      rec.spawnOpts.push(opts);
      return { sessionId: opts.sessionId };
    },
    send(_h: AdapterHandle, text: string) {
      rec.sent.push(text);
    },
    interrupt() {},
    async *events() {
      await new Promise(() => {}); // silent, never resolves
      yield undefined as never;
    },
    dispose() {},
  };
}

function failingAdapter(): HarnessAdapter {
  return {
    id: "fakefail" as never,
    capabilities: { permissions: false, subagents: false, streaming: true, queueWhileRunning: true },
    async listModels() {
      return [];
    },
    async spawn(): Promise<AdapterHandle> {
      throw new Error("spawn exploded");
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

test("schedule on create/update: validated, waterline computed, clearable", async () => {
  const { db, cleanup } = await freshServer("sched-crud");
  const tasks = await import("../src/tasks.js");
  const feed = await import("../src/feed.js");
  try {
    wipe(tasks, db, feed);
    const before = Date.now();
    const t = tasks.createTask({ title: "nightly", prompt: "go", cwd: "/tmp", harness: "pi", schedule: "0 3 * * *" });
    assert.equal(t.schedule, "0 3 * * *");
    assert.ok(t.nextRunAt! > before, "next run is in the future");
    assert.ok(t.nextRunAt! <= before + 86_400_000, "daily schedule fires within a day");

    /* invalid expressions reject at input time with the parse reason */
    assert.throws(
      () => tasks.createTask({ title: "x", prompt: "", cwd: "/tmp", harness: "pi", schedule: "61 * * * *" }),
      /bad schedule: minute/,
    );
    assert.throws(
      () => tasks.createTask({ title: "x", prompt: "", cwd: "/tmp", harness: "pi", schedule: "bogus" }),
      /bad schedule: need 5 fields/,
    );
    /* syntactically valid but never fires */
    assert.throws(
      () => tasks.createTask({ title: "x", prompt: "", cwd: "/tmp", harness: "pi", schedule: "0 0 31 2 *" }),
      /never fires/,
    );

    /* update: replace, then clear; both move the waterline */
    const resched = tasks.updateTask(t.id, { schedule: "*/30 * * * *" });
    assert.equal(resched.schedule, "*/30 * * * *");
    assert.ok(resched.nextRunAt! <= Date.now() + 30 * 60_000);
    const cleared = tasks.updateTask(t.id, { schedule: null });
    assert.equal(cleared.schedule, undefined);
    assert.equal(cleared.nextRunAt, undefined);
    /* "" clears too */
    const again = tasks.updateTask(t.id, { schedule: "0 9 * * 1" });
    assert.ok(again.nextRunAt);
    assert.equal(tasks.updateTask(t.id, { schedule: "" }).schedule, undefined);
    /* a bad update leaves the old schedule untouched */
    const withSched = tasks.updateTask(t.id, { schedule: "0 9 * * *" });
    assert.throws(() => tasks.updateTask(t.id, { schedule: "5-1 * * * *" }), /reversed/);
    assert.equal(tasks.getTaskApi(t.id)!.schedule, withSched.schedule);
  } finally {
    wipe(tasks, db, feed);
    cleanup();
  }
});

test("tick fires a due card through runTask and advances the waterline", async () => {
  const { db, cleanup } = await freshServer("sched-fire");
  const tasks = await import("../src/tasks.js");
  const feed = await import("../src/feed.js");
  const sessions = await import("../src/sessions.js");
  const scheduler = await import("../src/scheduler.js");
  const rec: { spawnOpts: SessionOpts[]; sent: string[] } = { spawnOpts: [], sent: [] };
  sessions.registerAdapter("fake" as never, fakeAdapter(rec));
  let sessionId: string | undefined;
  try {
    wipe(tasks, db, feed);
    const due = tasks.createTask({ title: "due now", prompt: "do it", cwd: "/tmp", harness: "fake", schedule: "* * * * *" });
    db.store.run(`UPDATE tasks SET next_run_at = ? WHERE id = ?`, Date.now() - 60_000, due.id);
    const notDue = tasks.createTask({ title: "later", prompt: "wait", cwd: "/tmp", harness: "fake", schedule: "0 3 * * *" });

    const now = Date.now();
    const r = await scheduler.runSchedulerTick(now);
    assert.deepEqual(r.ran, [due.id]);
    assert.deepEqual(r.failed, []);

    /* spawned + linked through the normal runTask path */
    assert.equal(rec.spawnOpts.length, 1);
    sessionId = rec.spawnOpts[0].sessionId;
    const card = tasks.getTaskApi(due.id)!;
    assert.equal(card.status, "doing");
    assert.equal(card.sessionId, sessionId);
    assert.ok(card.nextRunAt! > now, "waterline advanced past this tick");
    await tick(30);
    assert.deepEqual(rec.sent, ["do it"]);

    /* the not-due card was untouched */
    assert.equal(rec.spawnOpts.length, 1);
    assert.equal(tasks.getTaskApi(notDue.id)!.status, "todo");
  } finally {
    sessions.unregisterAdapter("fake" as never);
    if (sessionId) {
      sessions.closeSession(sessionId);
      db.store.deleteSession(sessionId);
    }
    wipe(tasks, db, feed);
    cleanup();
  }
});

test("tick catch-up coalesces downtime to ONE run + a 'missed N' note", async () => {
  const { db, cleanup } = await freshServer("sched-catchup");
  const tasks = await import("../src/tasks.js");
  const feed = await import("../src/feed.js");
  const sessions = await import("../src/sessions.js");
  const scheduler = await import("../src/scheduler.js");
  const rec: { spawnOpts: SessionOpts[]; sent: string[] } = { spawnOpts: [], sent: [] };
  sessions.registerAdapter("fake" as never, fakeAdapter(rec));
  let sessionId: string | undefined;
  try {
    wipe(tasks, db, feed);
    const t = tasks.createTask({ title: "every minute", prompt: "tick", cwd: "/tmp", harness: "fake", schedule: "* * * * *" });
    /* pretend the server was down for five minutes: waterline 5 slots back */
    const base = Math.floor(Date.now() / 60_000) * 60_000;
    db.store.run(`UPDATE tasks SET next_run_at = ? WHERE id = ?`, base - 5 * 60_000, t.id);

    const now = base + 500; // mid-minute, same slot
    const r = await scheduler.runSchedulerTick(now);
    assert.deepEqual(r.ran, [t.id]);
    sessionId = rec.spawnOpts[0]?.sessionId;
    assert.equal(rec.spawnOpts.length, 1, "coalesced to one run, not six");

    const note = feed.listFeed({}).find((i) => i.title.includes("Caught up scheduled task"));
    assert.ok(note, "catch-up note posted");
    assert.ok(note!.body.includes("skipped 5 missed runs"), note!.body);
    assert.equal(tasks.getTaskApi(t.id)!.nextRunAt, base + 60_000, "waterline at the next future slot");
  } finally {
    sessions.unregisterAdapter("fake" as never);
    if (sessionId) {
      sessions.closeSession(sessionId);
      db.store.deleteSession(sessionId);
    }
    wipe(tasks, db, feed);
    cleanup();
  }
});

test("tick skips a card whose previous run is still live (overlap policy)", async () => {
  const { db, cleanup } = await freshServer("sched-overlap");
  const tasks = await import("../src/tasks.js");
  const feed = await import("../src/feed.js");
  const sessions = await import("../src/sessions.js");
  const scheduler = await import("../src/scheduler.js");
  const rec: { spawnOpts: SessionOpts[]; sent: string[] } = { spawnOpts: [], sent: [] };
  sessions.registerAdapter("fake" as never, fakeAdapter(rec));
  let sessionId: string | undefined;
  try {
    wipe(tasks, db, feed);
    const t = tasks.createTask({ title: "long runner", prompt: "work", cwd: "/tmp", harness: "fake", schedule: "* * * * *" });
    /* first run goes through, leaving the card doing + linked */
    const { session } = await tasks.runTask(t.id);
    sessionId = session.id;
    db.store.setSessionState(session.id, "running");
    assert.equal(sessions.isLive(session.id), true);

    /* next slot fires while the previous run is still going → skip + note */
    db.store.run(`UPDATE tasks SET next_run_at = ? WHERE id = ?`, Date.now() - 60_000, t.id);
    const now = Date.now();
    const r = await scheduler.runSchedulerTick(now);
    assert.deepEqual(r.ran, []);
    assert.deepEqual(r.skipped, [t.id]);
    assert.equal(rec.spawnOpts.length, 1, "no second spawn while running");
    const note = feed.listFeed({}).find((i) => i.title.includes("Skipped scheduled run"));
    assert.ok(note, "skip note posted");
    assert.ok(tasks.getTaskApi(t.id)!.nextRunAt! > now, "skipped slot is still consumed");
  } finally {
    sessions.unregisterAdapter("fake" as never);
    if (sessionId) {
      sessions.closeSession(sessionId);
      db.store.deleteSession(sessionId);
    }
    wipe(tasks, db, feed);
    cleanup();
  }
});

test("tick failure: spawn errors stamp the card, advance the slot, and report", async () => {
  const { db, cleanup } = await freshServer("sched-fail");
  const tasks = await import("../src/tasks.js");
  const feed = await import("../src/feed.js");
  const sessions = await import("../src/sessions.js");
  const scheduler = await import("../src/scheduler.js");
  sessions.registerAdapter("fakefail" as never, failingAdapter());
  try {
    wipe(tasks, db, feed);
    const t = tasks.createTask({ title: "broken", prompt: "go", cwd: "/tmp", harness: "fakefail", schedule: "* * * * *" });
    db.store.run(`UPDATE tasks SET next_run_at = ? WHERE id = ?`, Date.now() - 60_000, t.id);
    const now = Date.now();
    const r = await scheduler.runSchedulerTick(now);
    assert.deepEqual(r.ran, []);
    assert.deepEqual(r.failed, [t.id]);

    const card = tasks.getTaskApi(t.id)!;
    assert.ok(card.lastRunAt! >= now, "failed run still stamps last_run_at");
    assert.ok(card.nextRunAt! > now, "a broken card does not retry every tick");
    const note = feed.listFeed({}).find((i) => i.type === "error" && i.title.includes("Scheduled run failed"));
    assert.ok(note, "failure reported to the feed");
    assert.ok(note!.body.includes("spawn exploded"), note!.body);
  } finally {
    sessions.unregisterAdapter("fakefail" as never);
    wipe(tasks, db, feed);
    cleanup();
  }
});

test("overlapping ticks never double-fire (audit B1): a slow spawn serializes the loop", async () => {
  const { db, cleanup } = await freshServer("sched-race");
  const tasks = await import("../src/tasks.js");
  const feed = await import("../src/feed.js");
  const sessions = await import("../src/sessions.js");
  const scheduler = await import("../src/scheduler.js");
  /* first spawn blocks on a gate we control; later spawns go through */
  let gate!: () => void;
  let spawnCalls = 0;
  let firstSpawnEntered!: Promise<void>;
  {
    let entered!: () => void;
    firstSpawnEntered = new Promise((r) => (entered = r));
    const slow: HarnessAdapter = {
      id: "fakeslow" as never,
      capabilities: { permissions: false, subagents: false, streaming: true, queueWhileRunning: true },
      async listModels() {
        return [];
      },
      async spawn(opts: SessionOpts): Promise<AdapterHandle> {
        spawnCalls++;
        if (spawnCalls === 1) {
          entered();
          await new Promise<void>((r) => (gate = r));
        }
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
    sessions.registerAdapter("fakeslow" as never, slow);
  }
  const spawnedIds: string[] = [];
  try {
    wipe(tasks, db, feed);
    /* TWO cards due in the same tick: the pre-fix bug had tick 2 fire B from
       its stale snapshot while tick 1 was still awaiting A's spawn */
    const a = tasks.createTask({ title: "A", prompt: "a", cwd: "/tmp", harness: "fakeslow", schedule: "* * * * *" });
    const b = tasks.createTask({ title: "B", prompt: "b", cwd: "/tmp", harness: "fakeslow", schedule: "* * * * *" });
    const past = Date.now() - 60_000;
    db.store.run(`UPDATE tasks SET next_run_at = ? WHERE id IN (?, ?)`, past, a.id, b.id);

    const tick1 = scheduler.runSchedulerTick(Date.now()); // not awaited: parks inside A's spawn
    await firstSpawnEntered;

    const tick2 = await scheduler.runSchedulerTick(Date.now() + 1000);
    assert.deepEqual(tick2, { ran: [], skipped: [], failed: [] }, "a collided tick is a no-op, not a second pass");

    gate(); // let A's spawn finish; tick 1 then processes B itself
    const r1 = await tick1;
    assert.deepEqual([...r1.ran].sort(), [a.id, b.id].sort());
    assert.equal(spawnCalls, 2, "each card spawned exactly once across both ticks");
    for (const s of [a.id, b.id]) {
      const sid = tasks.getTaskApi(s)!.sessionId!;
      assert.ok(sid);
      spawnedIds.push(sid);
    }
    /* waterlines advanced once per card, not twice */
    const now = Date.now();
    assert.ok(tasks.getTaskApi(a.id)!.nextRunAt! > now - 60_000);
    assert.ok(tasks.getTaskApi(b.id)!.nextRunAt! > now - 60_000);
  } finally {
    sessions.unregisterAdapter("fakeslow" as never);
    for (const sid of spawnedIds) {
      sessions.closeSession(sid);
      db.store.deleteSession(sid);
    }
    wipe(tasks, db, feed);
    cleanup();
  }
});

test("tick only fires todo/doing cards; restoring a parked card re-arms future slots", async () => {
  const { db, cleanup } = await freshServer("sched-columns");
  const tasks = await import("../src/tasks.js");
  const feed = await import("../src/feed.js");
  const sessions = await import("../src/sessions.js");
  const scheduler = await import("../src/scheduler.js");
  const rec: { spawnOpts: SessionOpts[]; sent: string[] } = { spawnOpts: [], sent: [] };
  sessions.registerAdapter("fake" as never, fakeAdapter(rec));
  try {
    wipe(tasks, db, feed);
    const done = tasks.createTask({ title: "parked", prompt: "go", cwd: "/tmp", harness: "fake", schedule: "* * * * *" });
    tasks.updateTask(done.id, { status: "done" });
    const arch = tasks.createTask({ title: "shelved", prompt: "go", cwd: "/tmp", harness: "fake", schedule: "* * * * *" });
    tasks.updateTask(arch.id, { status: "archived" });
    /* both overdue */
    db.store.run(`UPDATE tasks SET next_run_at = ? WHERE id IN (?, ?)`, Date.now() - 86_400_000, done.id, arch.id);

    const r = await scheduler.runSchedulerTick(Date.now());
    assert.deepEqual(r.ran, []);
    assert.equal(rec.spawnOpts.length, 0, "done/archived cards never fire");

    /* moving back to todo re-arms at the next FUTURE slot — no month of
       catch-up runs for a card that was parked */
    const restored = tasks.updateTask(done.id, { status: "todo" });
    assert.ok(restored.nextRunAt! > Date.now(), `re-armed in the future, got ${restored.nextRunAt}`);
  } finally {
    sessions.unregisterAdapter("fake" as never);
    wipe(tasks, db, feed);
    cleanup();
  }
});
