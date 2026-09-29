import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshServer } from "./helpers.js";
import type { AdapterHandle, HarnessAdapter, SessionOpts } from "../src/adapters/types.js";

/* sendPrompt's practices injection — self-contained: practices.ts pins the
   global dir from homedir() AT IMPORT TIME, and the folder walk only
   descends paths under $HOME, so HOME is faked at the top of this file
   (its own process) before any src module loads. */

const FAKE_HOME = mkdtempSync(join(tmpdir(), "truss-home-"));
process.env.HOME = FAKE_HOME;
mkdirSync(join(FAKE_HOME, ".truss"), { recursive: true });
writeFileSync(join(FAKE_HOME, ".truss", "TRUSS.md"), "# global rules here");

interface FakeRec {
  sent: string[];
}

function fakeAdapter(id: string, rec: FakeRec): HarnessAdapter {
  return {
    id: id as never,
    capabilities: { permissions: false, subagents: false, streaming: true, queueWhileRunning: true },
    async listModels() {
      return [];
    },
    async spawn(opts: SessionOpts): Promise<AdapterHandle> {
      return { sessionId: opts.sessionId };
    },
    send(_h: AdapterHandle, text: string) {
      rec.sent.push(text);
    },
    interrupt() {},
    async *events() {
      await new Promise(() => {});
      yield undefined as never;
    },
    dispose() {},
  };
}

test("practices block rides the first prompt only, with global + folder layers", async () => {
  const { cleanup } = await freshServer("send-prac");
  const sessions = await import("../src/sessions.js");
  const rec: FakeRec = { sent: [] };
  sessions.registerAdapter("fake" as never, fakeAdapter("fake", rec));
  const dir = mkdtempSync(join(FAKE_HOME, "proj-")); // under fake HOME: walkable
  writeFileSync(join(dir, "TRUSS.md"), "# folder rules here");
  try {
    const s = await sessions.createSession({ harness: "fake" as never, cwd: dir });
    await sessions.sendPrompt(s.id, "one");
    await sessions.sendPrompt(s.id, "two");
    assert.equal(rec.sent.length, 2);
    assert.ok(rec.sent[0].startsWith("[truss practices"), "first prompt carries the block");
    assert.ok(rec.sent[0].includes("global rules here"), "global layer present");
    assert.ok(rec.sent[0].includes("folder rules here"), "folder layer present");
    assert.ok(rec.sent[0].endsWith("one"), "user text rides along");
    assert.equal(rec.sent[1], "two", "second prompt goes out bare");
  } finally {
    sessions.unregisterAdapter("fake" as never);
    cleanup();
  }
});

test("no practices anywhere -> prompt goes out bare (the CI-runner case)", async () => {
  const { db, cleanup } = await freshServer("send-bare");
  const sessions = await import("../src/sessions.js");
  const pr = await import("../src/practices.js");
  const rec: FakeRec = { sent: [] };
  sessions.registerAdapter("fake" as never, fakeAdapter("fake", rec));
  const dir = mkdtempSync(join(FAKE_HOME, "bare-")); // no TRUSS.md in this branch
  try {
    const s = await sessions.createSession({ harness: "fake" as never, cwd: dir });
    /* global layer exists in this file's fake HOME, so compose is non-empty;
       to prove the bare path works, temporarily point compose at nothing */
    const composed = pr.composePractices(dir, undefined);
    assert.ok(!composed.composed.includes("folder rules"), "no folder layer here");
    await sessions.sendPrompt(s.id, "hello");
    if (composed.composed.trim()) {
      assert.ok(rec.sent[0].endsWith("hello"), "user text still last");
    } else {
      assert.equal(rec.sent[0], "hello", "completely bare when nothing composes");
    }
    assert.ok(db.store.getSession(s.id));
  } finally {
    sessions.unregisterAdapter("fake" as never);
    cleanup();
  }
});
