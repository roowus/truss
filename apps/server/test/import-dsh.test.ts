import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* Regression pin: the dsh import dedupes against every session row, trash
   included. listSessions() hides trashed chats (issue #5), so a dedupe set
   built from it forgets a trashed import's harness_ref — re-running
   POST /api/import/dsh would resurrect the deleted chat as a live duplicate
   while the trashed copy stays in the trash.

   DSH_SESSIONS_DIR is read at module import, so it is set here before the
   dynamic import (same trick freshServer uses for TRUSS_DATA_DIR). The log
   file is deliberately not real zstd: a correct import never reads it — the
   ref is already known — so the test pins the skip decision without needing
   a zstd binary. Without the dedupe fix the import walks past the skip and
   the unreadable log lands in result.failed instead. */

test("re-importing a trashed dsh session skips it instead of resurrecting a duplicate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "truss-test-dsh-import-"));
  const dshRoot = join(dir, "sessions", "proj");
  const dshId = "session-11111111-2222-3333-4444-555555555555";
  mkdirSync(join(dshRoot, dshId), { recursive: true });
  writeFileSync(join(dshRoot, dshId, "session.jsonl.zstd"), "not zstd — a known ref must never get this far");
  process.env.TRUSS_DATA_DIR = join(dir, "data");
  process.env.DSH_SESSIONS_DIR = join(dir, "sessions");

  const { store } = await import("../src/db.js");
  const { importDshSessions } = await import("../src/import-dsh.js");

  try {
    /* a previous import left this row behind; the user then trashed it */
    const id = "dsh-11111111"; // the id importDshSessions derives from the dir name
    store.createSessionRaw({
      id,
      harness: "dsh" as never,
      title: "imported chat",
      cwd: "/tmp",
      project: "imported:dsh",
      state: "closed",
      created_at: 1,
      updated_at: 2,
    });
    store.setHarnessRef(id, dshId);
    store.setDeletedAt(id, Date.now());
    assert.ok(!store.listSessions().some((s) => s.id === id), "precondition: the trashed import is out of the live list");

    const res = importDshSessions();
    assert.deepEqual(res.failed, [], "a known ref is skipped before any log is read, trash or not");
    assert.equal(res.imported, 0, "the trashed chat is not re-imported as a live duplicate");
    assert.ok(res.skipped >= 1, "the trashed ref still counts as known");
    assert.equal(store.all("SELECT id FROM sessions").length, 1, "no duplicate row");
    assert.ok(store.getSession(id), "the trashed copy survives untouched");
    assert.ok(store.getSession(id)?.deleted_at, "and it is still in the trash");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
