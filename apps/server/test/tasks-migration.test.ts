import { after } from "node:test";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshServer } from "./helpers.js";

/* tasks.ts schema migration pin (issue #16, audit B2): every other test runs
   against a fresh TRUSS_DATA_DIR, so a broken ALTER of an EXISTING pre-#16
   tasks table would only fail for real users on first query. This file is
   its own process (node --test per file), so the db/tasks modules import
   fresh here — we build the old-shape table with data BEFORE the tasks
   module gets to ensureTable. */

const fakeHome = mkdtempSync(join(tmpdir(), "truss-test-mig-home-"));
process.env.HOME = fakeHome;
after(() => rmSync(fakeHome, { recursive: true, force: true }));

test("pre-#16 tasks table (no schedule columns) migrates in place, data intact", async () => {
  const { db, cleanup } = await freshServer("tasks-migration");
  try {
    /* the exact pre-#16 shape, with a legacy row in it */
    db.store.exec(`
      CREATE TABLE tasks (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        prompt      TEXT NOT NULL DEFAULT '',
        cwd         TEXT NOT NULL,
        harness     TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'todo',
        session_id  TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        last_run_at INTEGER
      );
    `);
    db.store.run(
      `INSERT INTO tasks (id, title, prompt, cwd, harness, status, created_at, updated_at, last_run_at) VALUES ('legacy1', 'old card', 'p', '/tmp', 'pi', 'done', 1000, 2000, 1500)`,
    );

    /* first touch runs ensureTable → PRAGMA → ALTER TABLE ADD COLUMN ×2 */
    const tasks = await import("../src/tasks.js");
    const list = tasks.listTasks();
    assert.equal(list.length, 1, "legacy row survives the migration");
    assert.equal(list[0].id, "legacy1");
    assert.equal(list[0].status, "done", "columns preserved");
    assert.equal(list[0].lastRunAt, 1500);
    assert.equal(list[0].schedule, undefined, "new columns default to null → omitted in the API shape");
    assert.equal(list[0].nextRunAt, undefined);

    /* and the migrated table takes a scheduled insert */
    const t = tasks.createTask({ title: "new", prompt: "p", cwd: "/tmp", harness: "pi", schedule: "0 9 * * *" });
    assert.ok(t.nextRunAt! > Date.now() - 1000);
  } finally {
    cleanup();
  }
});
