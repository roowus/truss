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

    process.env.TRUSS_TEST_RESUME_DELAY = "1200";
    process.env.TRUSS_TEST_PUSH_USAGE_AT = "2000";
    process.env.TRUSS_TEST_ACP_LOG = METHOD_LOG;

    /* spawn 1 blows the 200ms budget while its resume is still in flight
       (the fake answers it at 1200ms — the budget timer's 1000ms of slack is
       deliberate: these preconditions are real timers, and a loaded runner
       must not be able to invert the ordering the test asserts) */
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

/* the OPPOSITE ordering (audit round 3, finding B1): the abandoned spawn is
   the FIRST to register, so it owns the key and ownsSession alone would let
   its teardown through — and that teardown sends session/close. The retry
   then registers into the freed key and goes live on a session the harness
   was told to release, so its first turn fails harness-side. An abandoned
   dispose must drop the frame handler and close the queue but stay off the
   wire: the harness session it resumed is exactly what the retry needs.

   The fake answers the FIRST session/resume after 1500ms (spawn 1 blows the
   200ms budget and lands at ~1500ms) and the second after 3000ms (the retry,
   started at ~200ms, registers at ~3200ms) — so the abandoned spawn owns the
   key when its dispose runs and the retry re-registers after it. The slack
   against the 200ms budget is seconds, not milliseconds: these preconditions
   are real timers, and ordering a loaded runner must not be able to invert.
   onSession is wrapped so the test can see the registration order and prove
   the dangerous ordering really happened, and a usage frame pushed after the
   retry's resume proves the retried session still receives frames. */

const ORDER_FAKE = `
const fs = require("fs");
const log = process.env.TRUSS_TEST_ACP_LOG;
let b = "";
let resumes = 0;
const delays = (process.env.TRUSS_TEST_RESUME_DELAYS || "0,0").split(",").map(Number);
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
      setTimeout(() => {
        answer({ ok: true });
        if (resumes === 2) {
          setTimeout(() => {
            process.stdout.write(JSON.stringify({
              jsonrpc: "2.0",
              method: "session/update",
              params: { sessionId: sid, update: { sessionUpdate: "usage_update", used: 9, size: 100 } },
            }) + "\\n");
          }, 50);
        }
      }, delays[resumes - 1] || 0);
      continue;
    }
    answer({ ok: true });
  }
});
`;

const ORDER_FAKE_DIR = mkdtempSync(join(tmpdir(), "truss-fake-hermes-order-"));
const ORDER_FAKE_BIN = join(ORDER_FAKE_DIR, "hermes-acp");
const ORDER_LOG = join(ORDER_FAKE_DIR, "methods.log");
writeFileSync(ORDER_FAKE_BIN, "#!/usr/bin/env node\n" + ORDER_FAKE + "\n", { mode: 0o755 });

test("an abandoned dispose that registered FIRST must not session/close the harness session a retry is resuming", async () => {
  const { db, cleanup } = await freshServer("late-dispose-order");
  const sessions = await import("../src/sessions.js");
  const hermes = await import("../src/adapters/hermes.js");
  /* the client is a module singleton bound to the binary path the file pinned
     at load — point it at this test's own fake before it boots. The earlier
     test killed its proc; make sure that exit has been processed so ensure()
     boots this fake fresh instead of writing to the dead pipe. */
  (hermes.client as any).launch.command = ORDER_FAKE_BIN;
  (hermes.client as any).proc?.kill("SIGKILL");
  await tick(100);
  process.env.TRUSS_TEST_RESUME_DELAYS = "1500,3000";
  process.env.TRUSS_TEST_ACP_LOG = ORDER_LOG;
  const registrations: unknown[] = [];
  const realOnSession = (hermes.client as any).onSession.bind(hermes.client);
  (hermes.client as any).onSession = (key: string, fn: unknown) => {
    registrations.push(fn);
    return realOnSession(key, fn);
  };
  try {
    /* a closed session with a stored harness ref — resume reuses it as the
       harness session id, so both spawns land on the same shared key */
    db.store.createSession({ id: "ord-1", harness: "hermes", title: "t", cwd: "/tmp" });
    db.store.setHarnessRef("ord-1", "hs-ord");

    /* spawn 1 gives up at the 200ms budget while its resume is in flight */
    const first = await sessions.resumeSession("ord-1", { spawnTimeoutMs: 200 });
    assert.equal(first, false, "the slow resume gives up at the budget");

    /* the retry — sendPrompt's auto-resume does the same thing; the fake
       answers it long after the abandoned spawn has registered */
    const second = await sessions.resumeSession("ord-1", { spawnTimeoutMs: 5000 });
    assert.equal(second, true, "the retry goes live on the stored ref");

    assert.equal(registrations.length, 2, "both spawns registered on the shared key");
    assert.equal(
      (hermes.client as any).sessionHandlers.get("hs-ord"),
      registrations[1],
      "the abandoned spawn registered first and was dropped — the retry owns the key",
    );

    let usage: { used?: number } | undefined;
    for (let waited = 0; waited < 4000 && !usage; waited += 100) {
      await tick(100);
      usage = db.store
        .listEvents("ord-1")
        .map((f) => f.ev)
        .find((e) => e.type === "ctx.usage") as { used?: number } | undefined;
    }
    assert.ok(usage, "the retried session must still receive frames after the abandoned spawn lands");
    const methods = readFileSync(ORDER_LOG, "utf8").split("\n").filter(Boolean);
    assert.equal(methods.filter((m) => m === "session/resume").length, 2, "both resumes reached the harness");
    assert.ok(
      !methods.includes("session/close"),
      `the abandoned dispose must not release the harness session the retry is resuming — got: ${methods.join(", ")}`,
    );
  } finally {
    delete (hermes.client as any).onSession;
    delete process.env.TRUSS_TEST_RESUME_DELAYS;
    delete process.env.TRUSS_TEST_ACP_LOG;
    sessions.closeSession("ord-1");
    cleanup();
    try {
      rmSync(ORDER_FAKE_DIR, { recursive: true, force: true });
    } catch {
      /* the fake may still be exiting; tmp dirs get reaped anyway */
    }
    /* the client is a module singleton and its proc is private — kill it so
       the fake doesn't hold the test process open */
    (hermes.client as any).proc?.kill("SIGKILL");
  }
});

/* the third interleaving, bracketed by the two orderings above but not
   covered by them: the abandoned spawn registers FIRST, the retry's
   registration is REFUSED while that owner still holds the key, and the
   owner's dispose frees the key one microtask later. Freeing must hand the
   key to the refused claimant — before that hand-off the retry went live
   with no handler and every frame for the session was silently dropped
   (chunks, tool calls, usage, permission prompts).

   The fake holds both resume answers and writes them in ONE stdout write:
   the recovery shape for a wedged harness is that it unblocks and answers
   its pending queue oldest first, so both answers land in one stdin chunk
   and the registration, the refusal and the freeing dispose all sit in one
   microtask drain. A usage frame pushed just after proves the retried
   session is still wired. */
const B1_FAKE = `
const fs = require("fs");
const log = process.env.TRUSS_TEST_ACP_LOG;
let b = "";
let resumes = 0;
let pending = [];
let flushArmed = false;
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
      pending.push(JSON.stringify({ jsonrpc: "2.0", id: r.id, result: { ok: true } }) + "\\n");
      if (resumes === 1 && !flushArmed) {
        flushArmed = true;
        setTimeout(() => {
          /* both answers in one write: the client parses both from a single
             stdin chunk, so neither registration can land in a separate turn */
          process.stdout.write(pending.join(""));
          pending = [];
          setTimeout(() => {
            process.stdout.write(JSON.stringify({
              jsonrpc: "2.0",
              method: "session/update",
              params: { sessionId: sid, update: { sessionUpdate: "usage_update", used: 11, size: 100 } },
            }) + "\\n");
          }, 50);
        }, +(process.env.TRUSS_TEST_FLUSH_AT || 0));
      }
      continue;
    }
    answer({ ok: true });
  }
});
`;

const B1_FAKE_DIR = mkdtempSync(join(tmpdir(), "truss-fake-hermes-claim-"));
const B1_FAKE_BIN = join(B1_FAKE_DIR, "hermes-acp");
const B1_LOG = join(B1_FAKE_DIR, "methods.log");
writeFileSync(B1_FAKE_BIN, "#!/usr/bin/env node\n" + B1_FAKE + "\n", { mode: 0o755 });

test("a retry refused while the abandoned spawn owns the key gets the key handed over when that dispose frees it", async () => {
  const { db, cleanup } = await freshServer("late-dispose-claim");
  const sessions = await import("../src/sessions.js");
  const hermes = await import("../src/adapters/hermes.js");
  /* the client is a module singleton bound to the binary path the file pinned
     at load — point it at this test's own fake before it boots, and let the
     previous test's dead proc be reaped so ensure() starts this one fresh */
  (hermes.client as any).launch.command = B1_FAKE_BIN;
  (hermes.client as any).proc?.kill("SIGKILL");
  await tick(100);
  process.env.TRUSS_TEST_FLUSH_AT = "1500";
  process.env.TRUSS_TEST_ACP_LOG = B1_LOG;
  /* record every registration and whether it was refused, so the test proves
     the dangerous ordering really happened instead of passing by luck */
  const registrations: { fn: unknown; refused: boolean }[] = [];
  const realOnSession = (hermes.client as any).onSession.bind(hermes.client);
  (hermes.client as any).onSession = (key: string, fn: unknown) => {
    registrations.push({ fn, refused: (hermes.client as any).sessionHandlers.has(key) });
    return realOnSession(key, fn);
  };
  try {
    /* a closed session with a stored harness ref — resume reuses it as the
       harness session id, so both spawns land on the same shared key */
    db.store.createSession({ id: "claim-1", harness: "hermes", title: "t", cwd: "/tmp" });
    db.store.setHarnessRef("claim-1", "hs-claim");

    /* spawn 1 blows the 200ms budget; the fake holds its answer until 1500ms,
       by which time the retry's resume is pending right behind it (the wide
       margin keeps the ordering stable on a loaded runner) */
    const first = await sessions.resumeSession("claim-1", { spawnTimeoutMs: 200 });
    assert.equal(first, false, "the slow resume gives up at the budget");

    /* the retry goes live while the abandoned spawn still holds the key */
    const second = await sessions.resumeSession("claim-1", { spawnTimeoutMs: 5000 });
    assert.equal(second, true, "the retry goes live on the stored ref");

    assert.equal(registrations.length, 2, "both spawns registered on the shared key");
    assert.equal(
      registrations[1].refused,
      true,
      "precondition: the retry registered while the abandoned spawn still owned the key",
    );
    assert.equal(
      (hermes.client as any).sessionHandlers.get("hs-claim"),
      registrations[1].fn,
      "the freeing dispose must hand the key to the refused claimant, not leave it empty",
    );

    let usage: { used?: number } | undefined;
    for (let waited = 0; waited < 4000 && !usage; waited += 100) {
      await tick(100);
      usage = db.store
        .listEvents("claim-1")
        .map((f) => f.ev)
        .find((e) => e.type === "ctx.usage") as { used?: number } | undefined;
    }
    assert.ok(usage, "the retried session must still receive frames after a refused registration");
    const methods = readFileSync(B1_LOG, "utf8").split("\n").filter(Boolean);
    assert.ok(
      !methods.includes("session/close"),
      `the abandoned dispose must stay off the wire — got: ${methods.join(", ")}`,
    );
  } finally {
    delete (hermes.client as any).onSession;
    delete process.env.TRUSS_TEST_FLUSH_AT;
    delete process.env.TRUSS_TEST_ACP_LOG;
    sessions.closeSession("claim-1");
    cleanup();
    try {
      rmSync(B1_FAKE_DIR, { recursive: true, force: true });
    } catch {
      /* the fake may still be exiting; tmp dirs get reaped anyway */
    }
    /* the client is a module singleton and its proc is private — kill it so
       the fake doesn't hold the test process open */
    (hermes.client as any).proc?.kill("SIGKILL");
  }
});

/* the claim list behind the hand-off: a slot would forget the first refused
   registration the moment a second one arrives, leaving that handle live with
   no handler and no claim — deaf to every frame for the session. With one
   owner and two refusals, freeing the key must walk the claims in order and
   a claimant leaving must drop only itself. */
test("two refused registrations on one key both keep their claim — neither leaves a live session deaf", async () => {
  const acp = await import("../src/adapters/acp.js");
  const client = new (acp as any).AcpClient({ command: "true", args: [] });
  const owner = () => {};
  const firstRefused = () => {};
  const secondRefused = () => {};

  client.onSession("hs-multi", owner);
  client.onSession("hs-multi", firstRefused);
  client.onSession("hs-multi", secondRefused);
  assert.equal(client.ownsSession("hs-multi", firstRefused), false, "precondition: the first refusal was refused");
  assert.equal(client.ownsSession("hs-multi", secondRefused), false, "precondition: the second refusal was refused");
  assert.equal(
    client.ownsSession("hs-multi", owner),
    true,
    "the owner keeps the key while both claimants wait",
  );

  /* a claimant going away drops only itself — the other keeps its turn */
  client.offSession("hs-multi", firstRefused);
  client.offSession("hs-multi", owner);
  assert.equal(
    client.ownsSession("hs-multi", secondRefused),
    true,
    "the surviving claimant is handed the key when the owner frees it",
  );

  /* and with the refusals still queued, freeing walks them in order */
  const client2 = new (acp as any).AcpClient({ command: "true", args: [] });
  const owner2 = () => {};
  const refusedA = () => {};
  const refusedB = () => {};
  client2.onSession("hs-order", owner2);
  client2.onSession("hs-order", refusedA);
  client2.onSession("hs-order", refusedB);
  client2.offSession("hs-order", owner2);
  assert.equal(client2.ownsSession("hs-order", refusedA), true, "the earliest refusal is handed the key first");
  assert.equal(client2.ownsSession("hs-order", refusedB), false, "the later refusal stays queued behind it");
  client2.offSession("hs-order", refusedA);
  assert.equal(client2.ownsSession("hs-order", refusedB), true, "the next claimant follows when that one leaves");
  client2.offSession("hs-order", refusedB);
  assert.equal((client2 as any).sessionHandlers.has("hs-order"), false, "the key is free once the last handler leaves");
});

/* the truth table behind that wire guard: an abandoned spawn stays off the
   wire only where the harness session is shared with a retry. A live resumed
   session closed by its owner is still released, and so is the abandoned
   spawn of a fresh session (nobody else uses that id) — the fix must not
   over-suppress the close. */
test("an abandoned dispose skips session/close for a resumed session only", async () => {
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
      /* a live resumed handle disposed by its owner: the harness is told */
      const owned = acp.makeSessionState(`t-owned2-${name}`, `acp-owned2-${name}`, "m");
      owned.resumed = true;
      owned.onFrame = () => {};
      (client as any).onSession(`acp-owned2-${name}`, owned.onFrame);
      adapter.dispose(owned);
      assert.ok(
        methods.includes("session/close"),
        `${name}: an owner's dispose still tells the harness to release the session`,
      );

      /* the abandoned spawn of a fresh session: its id is its own */
      methods.length = 0;
      const fresh = acp.makeSessionState(`t-fresh-${name}`, `acp-fresh-${name}`, "m");
      fresh.onFrame = () => {};
      (client as any).onSession(`acp-fresh-${name}`, fresh.onFrame);
      fresh.abandoned = true;
      adapter.dispose(fresh);
      assert.ok(
        methods.includes("session/close"),
        `${name}: an abandoned fresh spawn still releases its own harness session`,
      );

      /* the abandoned spawn of a resumed session: the retry is resuming this
         exact id — drop the handler, never touch the wire */
      methods.length = 0;
      const resumed = acp.makeSessionState(`t-abs-${name}`, `acp-abs-${name}`, "m");
      resumed.resumed = true;
      resumed.onFrame = () => {};
      (client as any).onSession(`acp-abs-${name}`, resumed.onFrame);
      resumed.abandoned = true;
      adapter.dispose(resumed);
      assert.ok(
        !methods.includes("session/close"),
        `${name}: an abandoned resume must not close the session a retry is resuming`,
      );
      assert.equal(
        (client as any).ownsSession(`acp-abs-${name}`, resumed.onFrame),
        false,
        `${name}: the abandoned frame handler is dropped all the same`,
      );
    } finally {
      delete (client as any).call;
    }
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
