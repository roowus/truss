import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshServer, tick } from "./helpers.js";

/* REGRESSION TEST — PR #44 audit round 1, finding B1.

   boundedSpawn disposes a handle that lands after the spawn budget gave up
   on it. On the ACP adapters that dispose works on a client SHARED by every
   session and keyed by the harness session id, and on resume/respawn that
   key is the stored resumeRef. So when a timed-out resume lands after a
   retry has already gone live on the same ref, its late teardown used to
   delete the live session's frame handler and send session/close: every
   session/update and permission prompt for that session was silently
   dropped while the row read idle. The dispose must only tear down what the
   handle still owns.

   The fake below drives the real hermes adapter (TRUSS_HERMES_BIN is pinned
   before sessions.js loads — same pattern as acp-timeout.test.ts). The
   FIRST session/resume it sees answers after TRUSS_TEST_RESUME_DELAY ms, so
   that spawn outlives the budget; later ones answer at once (the warm
   retry). TRUSS_TEST_PUSH_USAGE_AT ms after that first resume it pushes a
   usage_update for the resumed session — the frame the live session must
   still receive once the abandoned spawn lands. Every method received is
   appended to TRUSS_TEST_ACP_LOG so the test can see whether the harness
   was told to close a live session. */

const FAKE = `
const fs = require("fs");
const log = process.env.TRUSS_TEST_ACP_LOG;
let b = "";
let resumes = 0;
let pushArmed = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  b += c;
  let i;
  while ((i = b.indexOf("\\n")) >= 0) {
    const l = b.slice(0, i).trim();
    b = b.slice(i + 1);
    if (!l) continue;
    let r;
    try { r = JSON.parse(l) } catch { continue }
    if (r.method && log) fs.appendFileSync(log, r.method + "\\n");
    if (r.id == null || !r.method) continue;
    const answer = (res) =>
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: r.id, result: res }) + "\\n");
    if (r.method === "initialize") { answer({ protocolVersion: 1 }); continue }
    if (r.method === "session/resume") {
      resumes++;
      const sid = r.params && r.params.sessionId;
      if (resumes === 1) {
        const pushAt = +(process.env.TRUSS_TEST_PUSH_USAGE_AT || 0);
        if (pushAt && !pushArmed) {
          pushArmed = true;
          setTimeout(() => {
            process.stdout.write(JSON.stringify({
              jsonrpc: "2.0",
              method: "session/update",
              params: { sessionId: sid, update: { sessionUpdate: "usage_update", used: 7, size: 100 } },
            }) + "\\n");
          }, pushAt);
        }
        setTimeout(() => answer({ ok: true }), +(process.env.TRUSS_TEST_RESUME_DELAY || 0));
      } else {
        answer({ ok: true });
      }
      continue;
    }
    answer({ ok: true });
  }
});
`;

const FAKE_DIR = mkdtempSync(join(tmpdir(), "truss-fake-hermes-race-"));
const FAKE_BIN = join(FAKE_DIR, "hermes-acp");
const METHOD_LOG = join(FAKE_DIR, "methods.log");
writeFileSync(FAKE_BIN, "#!/usr/bin/env node\n" + FAKE + "\n", { mode: 0o755 });
process.env.TRUSS_HERMES_BIN = FAKE_BIN;

test("a resume that outlives the spawn budget must not tear down the live session a retry opened on the same ref", async () => {
  const { db, cleanup } = await freshServer("late-dispose-race");
  const sessions = await import("../src/sessions.js");
  try {
    /* a closed session with a stored harness ref — resume reuses it as the
       harness session id, so both spawns land on the same shared key */
    db.store.createSession({ id: "race-1", harness: "hermes", title: "t", cwd: "/tmp" });
    db.store.setHarnessRef("race-1", "hs-race");

    process.env.TRUSS_TEST_RESUME_DELAY = "400";
    process.env.TRUSS_TEST_PUSH_USAGE_AT = "800";
    process.env.TRUSS_TEST_ACP_LOG = METHOD_LOG;

    /* spawn 1 blows the 200ms budget while its resume is still in flight
       (the fake answers it at 400ms) */
    const first = await sessions.resumeSession("race-1", { spawnTimeoutMs: 200 });
    assert.equal(first, false, "the slow resume gives up at the budget");

    /* the retry — the harness is warm now, it answers at once and goes live
       on the same harness session id */
    const second = await sessions.resumeSession("race-1", { spawnTimeoutMs: 5000 });
    assert.equal(second, true, "the retry goes live on the stored ref");

    /* at ~400ms the abandoned spawn lands. Its dispose used to delete the
       live handler and send session/close for the shared harness session,
       after which frames for the session were silently dropped. */
    let usage: { used?: number } | undefined;
    for (let waited = 0; waited < 4000 && !usage; waited += 100) {
      await tick(100);
      usage = db.store
        .listEvents("race-1")
        .map((f) => f.ev)
        .find((e) => e.type === "ctx.usage") as { used?: number } | undefined;
    }
    assert.ok(usage, "frames for the live session must still arrive after the abandoned spawn lands");
    const methods = readFileSync(METHOD_LOG, "utf8").split("\n").filter(Boolean);
    assert.ok(
      !methods.includes("session/close"),
      `the abandoned dispose must not close the live harness session — got: ${methods.join(", ")}`,
    );
  } finally {
    delete process.env.TRUSS_TEST_RESUME_DELAY;
    delete process.env.TRUSS_TEST_PUSH_USAGE_AT;
    delete process.env.TRUSS_TEST_ACP_LOG;
    sessions.closeSession("race-1");
    cleanup();
    try {
      rmSync(FAKE_DIR, { recursive: true, force: true });
    } catch {
      /* the fake may still be exiting; tmp dirs get reaped anyway */
    }
    /* the client is a module singleton and its proc is private — kill it so
       the fake doesn't hold the test process open */
    const hermes = await import("../src/adapters/hermes.js");
    (hermes.client as any).proc?.kill("SIGKILL");
  }
});

/* the other side of the same guard: the race test above pins the skip side
   (no session/close for a session this handle doesn't own). If ownsSession
   broke the other way — or the close call was dropped — every test here
   would stay green while closing a live session stopped telling the harness
   to release its session (audit round 2, finding B2). */
test("disposing the handle that owns the session still closes it with the harness", async () => {
  const acp = await import("../src/adapters/acp.js");
  const hermes = await import("../src/adapters/hermes.js");
  const dsh = await import("../src/adapters/dsh.js");
  const cases = [
    ["hermes", hermes.hermesAdapter, hermes.client],
    ["dsh", dsh.dshAdapter, dsh.client],
  ] as const;
  for (const [name, adapter, client] of cases) {
    const methods: string[] = [];
    (client as any).call = (method: string) => {
      methods.push(method);
      return Promise.resolve({});
    };
    try {
      const h = acp.makeSessionState(`t-owned-${name}`, `acp-owned-${name}`, "m");
      h.onFrame = () => {};
      (client as any).onSession(`acp-owned-${name}`, h.onFrame);
      adapter.dispose(h);
      assert.ok(
        methods.includes("session/close"),
        `${name} must still tell the harness to release a session it owns — got: ${methods.join(", ") || "nothing"}`,
      );
      assert.equal(
        (client as any).ownsSession(`acp-owned-${name}`, h.onFrame),
        false,
        `${name} must release the frame handler along with the close`,
      );
    } finally {
      delete (client as any).call;
    }
  }
});
