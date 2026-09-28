import { after } from "node:test";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshServer, tick } from "./helpers.js";
import type { AdapterHandle, HarnessAdapter, SessionOpts } from "../src/adapters/types.js";

/* HOME is faked for the whole file process BEFORE any src import: practices.ts
   pins ~/.truss at import time, and sendPrompt would otherwise prepend the real
   user's global TRUSS.md to the task prompt (and read the real home dir). */
const fakeHome = mkdtempSync(join(tmpdir(), "truss-test-tasks-home-"));
process.env.HOME = fakeHome;
after(() => rmSync(fakeHome, { recursive: true, force: true }));

/* tasks.ts — the kanban task board on top of db.store. runTask would spawn a
   real harness; here a fake adapter stands in (same trick as sessions.test.ts)
   so the session link is tested without spawning anything.
   NOTE: the db module is process-cached, so every test in this file shares one
   SQLite store — each test wipes the tasks table to stay isolated. */

type Tasks = typeof import("../src/tasks.js");
type Db = typeof import("../src/db.js");

function wipe(tasks: Tasks, db: Db) {
  tasks.listTasks(); // ensures the table exists
  db.store.run("DELETE FROM tasks");
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

test("create: returns camelCase API row, raw row via getTask, blank title rejected", async () => {
  const { db, cleanup } = await freshServer("tasks-create");
  const tasks = await import("../src/tasks.js");
  try {
    wipe(tasks, db);
    const t = tasks.createTask({ title: "  fix flaky test  ", prompt: "go fix it", cwd: "/tmp", harness: "pi" });
    assert.ok(t.id, "has an id");
    assert.equal(t.title, "fix flaky test", "title is trimmed");
    assert.equal(t.prompt, "go fix it");
    assert.equal(t.cwd, "/tmp");
    assert.equal(t.harness, "pi");
    assert.equal(t.status, "todo");
    assert.equal(t.sessionId, undefined);
    assert.equal(t.lastRunAt, undefined);
    assert.ok(t.createdAt > 0 && t.updatedAt > 0);

    const raw = tasks.getTask(t.id)!;
    assert.equal(raw.title, "fix flaky test");
    assert.equal(raw.session_id, null, "raw row keeps snake_case + null");
    assert.equal(tasks.getTaskApi(t.id)!.id, t.id);
    assert.equal(tasks.getTask("no-such-id"), undefined);

    assert.throws(() => tasks.createTask({ title: "   ", prompt: "", cwd: "/tmp", harness: "pi" }), /title required/);
    assert.equal(tasks.listTasks().length, 1, "rejected create adds nothing");
  } finally {
    wipe(tasks, db);
    cleanup();
  }
});

test("update: title/prompt edits, status moves, bad status and unknown id rejected", async () => {
  const { db, cleanup } = await freshServer("tasks-update");
  const tasks = await import("../src/tasks.js");
  try {
    wipe(tasks, db);
    const t = tasks.createTask({ title: "t", prompt: "p", cwd: "/tmp", harness: "pi" });

    const renamed = tasks.updateTask(t.id, { title: "renamed", prompt: "new notes" });
    assert.equal(renamed.title, "renamed");
    assert.equal(renamed.prompt, "new notes");
    assert.equal(renamed.status, "todo", "status untouched by edit");
    assert.ok(renamed.updatedAt >= t.updatedAt);

    // walk the kanban states
    assert.equal(tasks.updateTask(t.id, { status: "doing" }).status, "doing");
    assert.equal(tasks.updateTask(t.id, { status: "done" }).status, "done");
    assert.equal(tasks.updateTask(t.id, { status: "archived" }).status, "archived");
    assert.equal(tasks.updateTask(t.id, { status: "todo" }).status, "todo");

    assert.throws(() => tasks.updateTask(t.id, { status: "bogus" as never }), /bad status/);
    assert.throws(() => tasks.updateTask("no-such-id", { title: "x" }), /no such task/);
  } finally {
    wipe(tasks, db);
    cleanup();
  }
});

test("list: ordered doing, todo, done, archived; updated_at DESC within a bucket", async () => {
  const { db, cleanup } = await freshServer("tasks-order");
  const tasks = await import("../src/tasks.js");
  try {
    wipe(tasks, db);
    const doing = tasks.createTask({ title: "doing", prompt: "", cwd: "/tmp", harness: "pi" });
    const todoNew = tasks.createTask({ title: "todo-new", prompt: "", cwd: "/tmp", harness: "pi" });
    const todoOld = tasks.createTask({ title: "todo-old", prompt: "", cwd: "/tmp", harness: "pi" });
    const done = tasks.createTask({ title: "done", prompt: "", cwd: "/tmp", harness: "pi" });
    const arch = tasks.createTask({ title: "arch", prompt: "", cwd: "/tmp", harness: "pi" });
    tasks.updateTask(doing.id, { status: "doing" });
    tasks.updateTask(done.id, { status: "done" });
    tasks.updateTask(arch.id, { status: "archived" });
    // pin updated_at directly so the DESC order within 'todo' is deterministic
    db.store.run(`UPDATE tasks SET updated_at = ? WHERE id = ?`, 9000, todoNew.id);
    db.store.run(`UPDATE tasks SET updated_at = ? WHERE id = ?`, 1000, todoOld.id);

    const order = tasks.listTasks().map((t) => t.id);
    assert.deepEqual(order, [doing.id, todoNew.id, todoOld.id, done.id, arch.id]);
  } finally {
    wipe(tasks, db);
    cleanup();
  }
});

test("delete: removes the row from get and list", async () => {
  const { db, cleanup } = await freshServer("tasks-delete");
  const tasks = await import("../src/tasks.js");
  try {
    wipe(tasks, db);
    const a = tasks.createTask({ title: "a", prompt: "", cwd: "/tmp", harness: "pi" });
    const b = tasks.createTask({ title: "b", prompt: "", cwd: "/tmp", harness: "pi" });
    tasks.deleteTask(a.id);
    assert.equal(tasks.getTask(a.id), undefined);
    assert.deepEqual(tasks.listTasks().map((t) => t.id), [b.id]);
    tasks.deleteTask(a.id); // deleting twice is a silent no-op
  } finally {
    wipe(tasks, db);
    cleanup();
  }
});

test("runTask: links a spawned session (fake adapter), flips to doing; validation rejects", async () => {
  const { db, cleanup } = await freshServer("tasks-run");
  const tasks = await import("../src/tasks.js");
  const sessions = await import("../src/sessions.js");
  const rec: { spawnOpts: SessionOpts[]; sent: string[] } = { spawnOpts: [], sent: [] };
  sessions.registerAdapter("fake" as never, fakeAdapter(rec));
  let sessionId: string | undefined;
  try {
    wipe(tasks, db);
    const t = tasks.createTask({ title: "run me", prompt: "do the thing", cwd: "/tmp", harness: "fake" });
    const { session } = await tasks.runTask(t.id);
    sessionId = session.id;

    // card links to the session and moves to doing
    const after = tasks.getTaskApi(t.id)!;
    assert.equal(after.status, "doing");
    assert.equal(after.sessionId, session.id);
    assert.ok(after.lastRunAt! > 0);

    // the session was spawned with the task's pinned harness + cwd
    assert.equal(rec.spawnOpts.length, 1);
    assert.equal(rec.spawnOpts[0].cwd, "/tmp");
    const row = db.store.getSession(session.id)!;
    assert.equal(row.harness, "fake");
    assert.equal(row.cwd, "/tmp");
    assert.equal(row.project, "taskboard");

    // the prompt is sent once the adapter is live
    await tick(30);
    assert.deepEqual(rec.sent, ["do the thing"]);

    // validation: unknown id and empty prompt reject without spawning
    await assert.rejects(() => tasks.runTask("no-such-id"), /no such task/);
    const noPrompt = tasks.createTask({ title: "np", prompt: "   ", cwd: "/tmp", harness: "fake" });
    await assert.rejects(() => tasks.runTask(noPrompt.id), /no prompt to run/);
    assert.equal(rec.spawnOpts.length, 1, "rejections never spawn");
  } finally {
    sessions.unregisterAdapter("fake" as never);
    if (sessionId) {
      sessions.closeSession(sessionId);
      db.store.deleteSession(sessionId);
    }
    wipe(tasks, db);
    cleanup();
  }
});
