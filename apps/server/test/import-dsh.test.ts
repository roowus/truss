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

/* issue #142 audit (B6): the importer bypasses the sink, so it must stamp
   `at` itself — an unstamped msg.done/tool.done replays with its own
   start's time and the trajectory timeline shows a fabricated 0ms span for
   every imported turn */
test("mapLog stamps every event with the record time, dones and tools included", async () => {
  process.env.TRUSS_DATA_DIR ??= mkdtempSync(join(tmpdir(), "truss-test-dsh-maplog-"));
  const { mapLog } = await import("../src/import-dsh.js");

  const T = 1_700_000_000_000;
  const { events } = mapLog(
    [
      { type: "session", createdAt: T, cwd: "/tmp" },
      { type: "user/message", time: T + 1000, data: { content: "hello" } },
      { type: "assistant/message", time: T + 5000, data: { message: { content: [{ type: "text", text: "hi there" }] } } },
      { type: "step/start", time: T + 2000 },
      { type: "tool/call", time: T + 3000, data: { callId: "c1", name: "bash", arguments: {} } },
      { type: "tool/result", time: T + 4000, data: { message: { content: [{ type: "tool-result", toolCallId: "c1", content: "ok" }] } } },
      { type: "step/end", time: T + 6000 },
    ],
    "imp-test",
  );

  assert.ok(events.length > 0);
  for (const e of events) {
    assert.ok(typeof (e as { at?: number }).at === "number" && (e as { at: number }).at >= T, `${e.type} carries the record time`);
  }
  const start = events.find((e) => e.type === "msg.start" && (e as { role?: string }).role === "assistant") as { messageId: string; at: number };
  const done = events.find((e) => e.type === "msg.done" && (e as { messageId?: string }).messageId === start.messageId) as { at: number };
  assert.ok(done.at >= start.at, "the imported assistant span is a real pair");
  const tDone = events.find((e) => e.type === "tool.done") as { at: number };
  const tCall = events.find((e) => e.type === "tool.call") as { at: number };
  assert.ok(tDone.at > tCall.at, "the imported tool span is a real pair");
});
