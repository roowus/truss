import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshServer, tick } from "./helpers.js";
import type { AdapterHandle, HarnessAdapter, SessionOpts } from "../src/adapters/types.js";
import type { ProtoEvent } from "@truss/proto";

/* sessions.ts — the session lifecycle layer. Uses a fake adapter registered
   under a fake harness id so the whole create/send/resume/close flow runs
   against a real (temp) SQLite store without spawning anything. */

interface FakeRec {
  spawnOpts: SessionOpts[];
  sent: string[];
  disposed: number;
}

function fakeAdapter(id: string, rec: FakeRec, ref?: string): HarnessAdapter {
  return {
    id: id as never,
    capabilities: { permissions: false, subagents: false, streaming: true, queueWhileRunning: true },
    async listModels() {
      return [];
    },
    async spawn(opts: SessionOpts): Promise<AdapterHandle> {
      rec.spawnOpts.push(opts);
      const handle: AdapterHandle = { sessionId: opts.sessionId, harnessRef: ref };
      return handle;
    },
    send(_h: AdapterHandle, text: string) {
      rec.sent.push(text);
    },
    interrupt() {},
    async *events() {
      /* silent: no harness events in these tests */
      await new Promise(() => {});
      yield undefined as never;
    },
    dispose() {
      rec.disposed++;
    },
  };
}

test("createSession stores provider+model and spawns with them", async () => {
  const { db, cleanup } = await freshServer("sess-create");
  const sessions = await import("../src/sessions.js");
  const rec: FakeRec = { spawnOpts: [], sent: [], disposed: 0 };
  sessions.registerAdapter("fake" as never, fakeAdapter("fake", rec));
  try {
    const s = await sessions.createSession({
      harness: "fake" as never,
      cwd: "/tmp",
      model: "accounts/fireworks/models/kimi-k3",
      provider: "truss-fw",
    });
    assert.equal(rec.spawnOpts.length, 1);
    assert.equal(rec.spawnOpts[0].provider, "truss-fw");
    assert.equal(rec.spawnOpts[0].model, "accounts/fireworks/models/kimi-k3");
    const row = db.store.getSession(s.id)!;
    assert.equal(row.provider, "truss-fw");
    assert.equal(row.model, "accounts/fireworks/models/kimi-k3");
  } finally {
    sessions.unregisterAdapter("fake" as never);
    cleanup();
  }
});

test("resumeSession respawns with the STORED provider+model+ref (regression: silent 400)", async () => {
  const { db, cleanup } = await freshServer("sess-resume");
  const sessions = await import("../src/sessions.js");
  const rec: FakeRec = { spawnOpts: [], sent: [], disposed: 0 };
  sessions.registerAdapter("fake" as never, fakeAdapter("fake", rec, "harness-ref-1"));
  try {
    const s = await sessions.createSession({
      harness: "fake" as never,
      cwd: "/tmp",
      model: "accounts/fireworks/models/kimi-k3",
      provider: "truss-fw",
    });
    db.store.setHarnessRef(s.id, "harness-ref-1");
    sessions.closeSession(s.id);
    db.store.setSessionState(s.id, "closed");

    const ok = await sessions.resumeSession(s.id);
    assert.equal(ok, true);
    assert.equal(rec.spawnOpts.length, 2);
    const resume = rec.spawnOpts[1];
    assert.equal(resume.provider, "truss-fw");
    assert.equal(resume.model, "accounts/fireworks/models/kimi-k3");
    assert.equal(resume.resumeRef, "harness-ref-1");
    assert.equal(db.store.getSession(s.id)?.state, "idle");
  } finally {
    sessions.unregisterAdapter("fake" as never);
    cleanup();
  }
});

test("resumeSession returns false without a harness ref", async () => {
  const { cleanup } = await freshServer("sess-noresume");
  const sessions = await import("../src/sessions.js");
  const rec: FakeRec = { spawnOpts: [], sent: [], disposed: 0 };
  sessions.registerAdapter("fake" as never, fakeAdapter("fake", rec));
  try {
    const s = await sessions.createSession({ harness: "fake" as never, cwd: "/tmp" });
    sessions.closeSession(s.id);
    const ok = await sessions.resumeSession(s.id);
    assert.equal(ok, false);
    assert.equal(rec.spawnOpts.length, 1); // no second spawn
  } finally {
    sessions.unregisterAdapter("fake" as never);
    cleanup();
  }
});

test("sendPrompt: local echo persists, auto-titles, resumes dead sessions", async () => {
  const { db, cleanup } = await freshServer("sess-send");
  const sessions = await import("../src/sessions.js");
  const rec: FakeRec = { spawnOpts: [], sent: [], disposed: 0 };
  sessions.registerAdapter("fake" as never, fakeAdapter("fake", rec, "ref-x"));
  try {
    const s = await sessions.createSession({ harness: "fake" as never, cwd: "/tmp" });
    await sessions.sendPrompt(s.id, "  fix   the   flaky test  ");
    // adapter got the text
    assert.equal(rec.sent.length, 1);
    assert.ok(rec.sent[0].includes("fix   the   flaky test"));
    // user echo persisted as start/chunk/done
    const evs = db.store.listEvents(s.id).map((f) => f.ev);
    const userStart = evs.find((e) => e.type === "msg.start" && (e as { role?: string }).role === "user");
    const chunk = evs.find((e) => e.type === "msg.chunk");
    const done = evs.find((e) => e.type === "msg.done");
    assert.ok(userStart && chunk && done);
    // auto-title from first prompt
    assert.equal(db.store.getSession(s.id)?.title, "fix the flaky test");

    // kill the session, give it a ref, send again -> auto-resume then send
    db.store.setHarnessRef(s.id, "ref-x");
    sessions.closeSession(s.id);
    db.store.setSessionState(s.id, "closed");
    await sessions.sendPrompt(s.id, "second");
    assert.equal(rec.spawnOpts.length, 2);
    assert.equal(rec.spawnOpts[1].resumeRef, "ref-x");
    assert.equal(rec.sent.length, 2);
  } finally {
    sessions.unregisterAdapter("fake" as never);
    cleanup();
  }
});

test("sendPrompt: practices ride the FIRST prompt only (non-MCP harness)", async () => {
  const { cleanup } = await freshServer("sess-practices");
  const sessions = await import("../src/sessions.js");
  const rec: FakeRec = { spawnOpts: [], sent: [], disposed: 0 };
  sessions.registerAdapter("fake" as never, fakeAdapter("fake", rec));
  const dir = mkdtempSync(join(tmpdir(), "truss-prac-"));
  writeFileSync(join(dir, "TRUSS.md"), "# house rules\nalways test");
  try {
    const s = await sessions.createSession({ harness: "fake" as never, cwd: dir });
    await sessions.sendPrompt(s.id, "one");
    await sessions.sendPrompt(s.id, "two");
    assert.equal(rec.sent.length, 2);
    assert.ok(rec.sent[0].includes("[truss practices"), "first prompt carries the block");
    assert.ok(rec.sent[0].includes("house rules"), "folder TRUSS.md is in it");
    assert.ok(rec.sent[0].endsWith("one"), "user text rides along");
    assert.equal(rec.sent[1], "two", "second prompt is bare");
  } finally {
    sessions.unregisterAdapter("fake" as never);
    cleanup();
  }
});

test("sendPrompt: MCP-attached harnesses never get the practices block", async () => {
  const { cleanup } = await freshServer("sess-mcp");
  const sessions = await import("../src/sessions.js");
  const rec: FakeRec = { spawnOpts: [], sent: [], disposed: 0 };
  // dsh is in MCP_ATTACHED — the fake stands in for it to keep spawns local
  sessions.registerAdapter("dsh" as never, fakeAdapter("dsh", rec));
  const dir = mkdtempSync(join(tmpdir(), "truss-prac-"));
  writeFileSync(join(dir, "TRUSS.md"), "# house rules");
  try {
    const s = await sessions.createSession({ harness: "dsh" as never, cwd: dir });
    await sessions.sendPrompt(s.id, "hello");
    assert.equal(rec.sent[0], "hello", "no injection for MCP harnesses");
  } finally {
    sessions.unregisterAdapter("dsh" as never);
    cleanup();
  }
});

test("sendPrompt: rejects unknown sessions", async () => {
  const { cleanup } = await freshServer("sess-unknown");
  const sessions = await import("../src/sessions.js");
  await assert.rejects(() => sessions.sendPrompt("nope-nope", "hi"), /no such session/);
  cleanup();
});

test("closeSession disposes the adapter handle once", async () => {
  const { cleanup } = await freshServer("sess-close");
  const sessions = await import("../src/sessions.js");
  const rec: FakeRec = { spawnOpts: [], sent: [], disposed: 0 };
  sessions.registerAdapter("fake" as never, fakeAdapter("fake", rec));
  try {
    const s = await sessions.createSession({ harness: "fake" as never, cwd: "/tmp" });
    sessions.closeSession(s.id);
    sessions.closeSession(s.id); // second close is a no-op
    assert.equal(rec.disposed, 1);
    await tick();
  } finally {
    sessions.unregisterAdapter("fake" as never);
    cleanup();
  }
});
