import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshServer, tick } from "./helpers.js";
import type { AdapterHandle, HarnessAdapter, SessionOpts } from "../src/adapters/types.js";

/* SPEC-TESTS for the silent-death family — https://github.com/roowus/truss/issues/97
   ("Sometimes truss chats just straight up don't work" — the deep audit).
   These FAIL on purpose today: they pin the top of the audit's taxonomy
   (full list + evidence in the issue):

   1. PUMP-END RESUME: when an adapter's event stream ENDS (harness died,
      socket dropped), the session must leave `live` — otherwise the next
      prompt writes into a dead handle and the closed/error→resume branch
      never fires (sessions.ts goLive pump has no finally). Pin: a prompt
      after pump-end RESPAWNS the harness.
   2. RESUME WITHOUT AN ID: a session/resume response lacking a sessionId
      must REJECT the spawn — falling back to the requested (dead) ref
      re-arms the ghost: instant empty "refusal" settles forever.
      (hermes-acp answers prompts to unknown sessions with an instant
      {"stopReason":"refusal"} — 55ms, no content — probe evidence in #96.)
   3. UNROUTABLE REQUESTS GET ANSWERED: an ACP server→client request (e.g.
      session/request_permission) for an unknown session must get an error
      response back — dropping it leaves the harness awaiting an answer and
      busy-wedges the session forever.
   4. STDIN EPIPE GUARD: pi + claude must attach an error listener to the
      child's stdin (acp.ts does; those two never got it) — a write in the
      death window is an uncaughtException and takes the WHOLE SERVER down.
      (Pins the TRUSS_PI_BIN / TRUSS_CLAUDE_BIN seams too.) */

/* ── 1. pump-end → resume on next prompt ── */

interface Rec {
  spawns: number;
  sent: string[];
}

function dyingAdapter(id: string, rec: Rec): HarnessAdapter {
  let sid = "unset";
  return {
    id: id as never,
    capabilities: { permissions: false, subagents: false, streaming: true, queueWhileRunning: true },
    async listModels() {
      return [];
    },
    async spawn(opts: SessionOpts): Promise<AdapterHandle> {
      rec.spawns++;
      sid = opts.sessionId;
      return { sessionId: opts.sessionId, harnessRef: `ref-${rec.spawns}` };
    },
    send(_h, text) {
      rec.sent.push(text);
    },
    interrupt() {},
    /* the dying harness: one idle beat, then the stream ENDS (queue closed) */
    async *events() {
      yield { type: "session.state", sessionId: sid, state: "idle" } as never;
      return;
    },
    dispose() {},
  };
}

test("a prompt after the event pump ended RESUMES the harness instead of writing into the void", async () => {
  const { db, cleanup } = await freshServer("pump-end");
  const sessions = await import("../src/sessions.js");
  const rec: Rec = { spawns: 0, sent: [] };
  sessions.registerAdapter("fake-dying" as never, dyingAdapter("fake-dying", rec));
  try {
    const s = await sessions.createSession({ harness: "fake-dying" as never, cwd: "/tmp" });
    assert.equal(rec.spawns, 1);
    await tick(100); // the pump runs to completion (stream ended = harness gone)

    await sessions.sendPrompt(s.id, "are you there?");
    assert.equal(
      rec.spawns,
      2,
      "the pump ended → the session is NOT live → sendPrompt must resume (today the stale live entry swallows the prompt into a dead handle — the user sees their own bubble and silence)",
    );
    assert.ok(db.store.getSession(s.id), "session row intact");
  } finally {
    sessions.unregisterAdapter("fake-dying" as never);
    cleanup();
  }
});

/* ── 2. resume without a sessionId rejects ── */

const DIR = mkdtempSync(join(tmpdir(), "truss-noidx-"));
const FAKE = `
setTimeout(() => process.exit(0), 5000); // never outlive the test
let b = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  b += c; let i;
  while ((i = b.indexOf("\\n")) >= 0) {
    const l = b.slice(0, i).trim(); b = b.slice(i + 1);
    if (!l) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (r.id == null || !r.method) continue;
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: r.id, result }) + "\\n");
    if (r.method === "initialize") reply({ protocolVersion: 1 });
    else if (r.method === "session/resume") reply({}); /* ACK, but no sessionId — the ghost re-arm */
    else reply({});
  }
});
`;
writeFileSync(join(DIR, "noid.cjs"), FAKE);
const NOID_BIN = join(DIR, "noid-bin.sh");
writeFileSync(NOID_BIN, `#!/bin/sh\nexec ${process.execPath} ${join(DIR, "noid.cjs")}\n`, { mode: 0o755 });
const PISH_DIR = mkdtempSync(join(tmpdir(), "truss-pipipe-"));
writeFileSync(join(PISH_DIR, "idle.cjs"), "setTimeout(()=>process.exit(0),5000);process.stdin.on('data',()=>{});");
const PISH_BIN = join(PISH_DIR, "idle-bin.sh");
writeFileSync(PISH_BIN, `#!/bin/sh\nexec ${process.execPath} ${join(PISH_DIR, "idle.cjs")}\n`, { mode: 0o755 });

/* module-level, before any test imports sessions.js (which transitively
   imports the adapters and reads this env at their module load) */
process.env.TRUSS_PI_BIN = PISH_BIN;
process.env.TRUSS_HERMES_BIN = NOID_BIN;
process.env.TRUSS_CLAUDE_BIN = PISH_BIN;
/* the idless-resume rejection waits one watch window for a session/update;
   shrink it so test 2 doesn't pay the production default */
process.env.TRUSS_ACP_RESUME_WATCH_MS = "1500";

test("a resume response without a sessionId rejects the spawn (never adopt the dead ref)", async () => {
  const { cleanup } = await freshServer("noid");
  try {
    const hermes: any = await import("../src/adapters/hermes.js");
    await assert.rejects(
      () => hermes.hermesAdapter.spawn({ sessionId: "t-noid", cwd: "/tmp", resumeRef: "dead-ref" }),
      /sessionId|missing|invalid|resume/i,
      "an idless resume ACK must fail the spawn — today it silently keeps the dead ref and every prompt black-holes (the reported symptom)",
    );
  } finally {
    delete process.env.TRUSS_HERMES_BIN;
    cleanup();
  }
});

/* ── 3. unroutable ACP requests get an error answer ── */

test("an unroutable server→client request is answered with an error, not dropped", async () => {
  const { cleanup } = await freshServer("unroutable");
  try {
    const { AcpClient } = await import("../src/adapters/acp.js");
    /* fake server: answers initialize, then issues session/request_permission
       for a session the client never registered, and records whether ANY
       frame answering srv-1 comes back; debug/dump reports the record */
    const script = `
      let b=""; let answered=null;
      process.stdin.setEncoding("utf8");
      process.stdin.on("data",(c)=>{ b+=c; let i;
        while((i=b.indexOf("\\n"))>=0){ const l=b.slice(0,i).trim(); b=b.slice(i+1); if(!l) continue;
          let r; try{ r=JSON.parse(l);}catch{continue}
          if(String(r.id)==="srv-1" && !r.method){ answered={ hadError: !!r.error, result: r.result ?? null }; continue; }
          if(!r.method) continue;
          if(r.method==="initialize"){ process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:r.id,result:{protocolVersion:1}})+"\\n");
            setTimeout(()=>process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:"srv-1",method:"session/request_permission",params:{sessionId:"ghost-session",toolCall:{title:"x"},options:[]}})+"\\n"),30); }
          else if(r.method==="debug/dump"){ process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:r.id,result:{answered}})+"\\n"); }
          else { process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:r.id,result:{}})+"\\n"); }
        }});
    `;
    const client = new (AcpClient as any)({ command: process.execPath, args: ["-e", script] }, { requestTimeoutMs: 2500 });
    try {
      await client.ensure();
      await tick(150); // the fake issues the ghost request at +30ms
      const dump = (await (client as any).call("debug/dump", {})) as { answered: { hadError: boolean; result: unknown } | null };
      assert.ok(dump.answered, "the unroutable permission request got a response frame — today it's dropped and the harness waits forever (busy-wedge)");
      assert.ok(dump.answered.hadError || JSON.stringify(dump.answered.result ?? {}).match(/cancel|refus|reject/i), "answered as an error/cancel — never an approval");
    } finally {
      (client as any).proc?.kill("SIGKILL");
    }
  } finally {
    cleanup();
  }
});

/* ── 4. stdin EPIPE guards ── */


test("pi + claude attach an error listener to the child's stdin (EPIPE can't down the server)", async () => {
  const { cleanup } = await freshServer("epipe");
  try {
    const pi: any = await import("../src/adapters/pi.js");
    assert.ok(process.env.TRUSS_PI_BIN, "pi needs the binary override seam (issue #29/#97) for this to be testable");

    const ph = await pi.piAdapter.spawn({ sessionId: "t-epipe-pi", cwd: "/tmp" });
    try {
      assert.ok(
        (ph as any).proc.stdin.listenerCount("error") >= 1,
        "pi: no stdin error listener — a write in the death window is an uncaughtException and the WHOLE server dies (verified empirically in the audit)",
      );
    } finally {
      pi.piAdapter.dispose(ph); /* undisposed handles hold the test process open */
    }

    const claude: any = await import("../src/adapters/claude.js");
    const ch = await claude.claudeAdapter.spawn({ sessionId: "t-epipe-cl", cwd: "/tmp" });
    try {
      assert.ok(
        (ch as any).proc.stdin.listenerCount("error") >= 1,
        "claude: same guard missing (and TRUSS_CLAUDE_BIN didn't exist — added with the fix)",
      );
    } finally {
      claude.claudeAdapter.dispose(ch);
    }
  } finally {
    cleanup();
  }
});

/* ── 5. shared-process death unwinds every live session (audit round 1: B1/B2/B3) ── */

/* fake hermes-acp: normal handshake/new/resume; on session/prompt it opens a
   permission card and then NEVER settles the turn — the shape of a harness
   dying mid-turn with a question on screen */
const DEATH_DIR = mkdtempSync(join(tmpdir(), "truss-death-"));
const DEATH_FAKE = `
let b = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  b += c; let i;
  while ((i = b.indexOf("\\n")) >= 0) {
    const l = b.slice(0, i).trim(); b = b.slice(i + 1);
    if (!l) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (r.id == null || !r.method) continue;
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: r.id, result }) + "\\n");
    if (r.method === "initialize") reply({ protocolVersion: 1 });
    else if (r.method === "session/new") reply({ sessionId: "hs-death", models: { availableModels: [{ modelId: "custom:x" }], currentModelId: "custom:x" } });
    else if (r.method === "session/resume") reply({ sessionId: "hs-death-r" });
    else if (r.method === "session/prompt") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: "perm-1", method: "session/request_permission",
        params: { sessionId: r.params?.sessionId, toolCall: { title: "rm -rf /" }, options: [{ optionId: "allow", name: "allow" }] } }) + "\\n");
      /* and then silence forever — the process will be killed mid-turn */
    }
    else reply({});
  }
});
`;
writeFileSync(join(DEATH_DIR, "death.cjs"), DEATH_FAKE);
const DEATH_BIN = join(DEATH_DIR, "death-bin.sh");
writeFileSync(DEATH_BIN, `#!/bin/sh\nexec ${process.execPath} ${join(DEATH_DIR, "death.cjs")}\n`, { mode: 0o755 });

test("a dead ACP process unwinds its live sessions: the mid-turn settle lands, pending perms cancel, the next prompt resumes", async () => {
  const { db, cleanup } = await freshServer("proc-death");
  const sessions = await import("../src/sessions.js");
  const hermes: any = await import("../src/adapters/hermes.js");
  /* retarget the module-singleton client at this test's fake (the
     acp-late-dispose pattern) and boot it fresh */
  hermes.client.launch.command = DEATH_BIN;
  hermes.client.proc?.kill("SIGKILL");
  await tick(100);
  let s: { id: string } | undefined;
  try {
    s = await sessions.createSession({ harness: "hermes" as never, cwd: "/tmp" });
    assert.ok(sessions.isLive(s.id), "session live after spawn");

    await sessions.sendPrompt(s.id, "hold this turn open");
    let evs: any[] = [];
    for (let w = 0; w < 3000; w += 50) {
      await tick(50);
      evs = db.store.listEvents(s.id).map((f: any) => f.ev);
      if (evs.some((e) => e.type === "perm.request")) break;
    }
    assert.ok(
      evs.some((e) => e.type === "perm.request"),
      "precondition: the permission card is on screen when the harness dies",
    );

    /* the harness process dies mid-turn, the permission unanswered */
    hermes.client.proc.kill("SIGKILL");
    for (let w = 0; w < 3000; w += 50) {
      await tick(50);
      evs = db.store.listEvents(s.id).map((f: any) => f.ev);
      if (evs.some((e) => e.type === "session.state" && e.state === "error")) break;
    }

    assert.ok(
      evs.some((e) => e.type === "msg.done" && /error/i.test(String(e.stopReason ?? ""))),
      "B1: the mid-turn bubble closes with an error — if the queue closes before the rejected prompt settles, the bubble stays open forever",
    );
    const callDone = evs.find((e) => e.type === "llm.call.done");
    assert.ok(callDone && callDone.status >= 400, "B1: the trajectory row settles as a failure");
    assert.ok(
      evs.some((e) => e.type === "perm.resolve" && e.choice === "cancelled"),
      "B3: a permission card pending at death is cancelled — a dead harness can't be answered",
    );
    assert.ok(
      evs.some((e) => e.type === "session.state" && e.state === "error"),
      "B2: the session row flips to error",
    );
    assert.ok(!sessions.isLive(s.id), "B2: the session leaves live");

    /* the next prompt resumes on the stored ref instead of writing into the void */
    await sessions.sendPrompt(s.id, "come back");
    assert.ok(sessions.isLive(s.id), "B2: the prompt after the death resumed the harness");
  } finally {
    if (s)
      try {
        sessions.closeSession(s.id);
      } catch {}
    hermes.client.proc?.kill("SIGKILL");
    cleanup();
  }
});

/* ── 6. idless resume ACK healed by the session/update that follows ── */

/* the REAL hermes-acp shape (probed live after the developer's PR #98
   report): session/resume answers {models, modes} with NO sessionId — for a
   live session AND for a dead ref it silently recreates — and the real
   session id arrives as params.sessionId of the session/update frames right
   after. Rejecting the idless ACK outright made every closed hermes session
   unresumable; adopting the requested ref is the ghost. The fix reads the id
   from the first session/update, and only a response with neither id nor
   following update is the ghost that must fail (test 2 above). */
const LAZY_DIR = mkdtempSync(join(tmpdir(), "truss-lazyid-"));
const LAZY_FAKE = `
let b = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  b += c; let i;
  while ((i = b.indexOf("\\n")) >= 0) {
    const l = b.slice(0, i).trim(); b = b.slice(i + 1);
    if (!l) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (r.id == null || !r.method) continue;
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: r.id, result }) + "\\n");
    if (r.method === "initialize") reply({ protocolVersion: 1 });
    else if (r.method === "session/resume") {
      reply({ models: { availableModels: [], currentModelId: "custom:x" } }); /* idless ACK — the real hermes shape */
      setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update",
        params: { sessionId: "hs-fresh-1", update: { sessionUpdate: "usage_update", used: 1, size: 100 } } }) + "\\n"), 30);
    }
    else reply({});
  }
});
`;
writeFileSync(join(LAZY_DIR, "lazy.cjs"), LAZY_FAKE);
const LAZY_BIN = join(LAZY_DIR, "lazy-bin.sh");
writeFileSync(LAZY_BIN, `#!/bin/sh\nexec ${process.execPath} ${join(LAZY_DIR, "lazy.cjs")}\n`, { mode: 0o755 });

test("an idless resume ACK adopts the sessionId from the session/update that follows (real hermes shape)", async () => {
  const { cleanup } = await freshServer("lazyid");
  const hermes: any = await import("../src/adapters/hermes.js");
  hermes.client.launch.command = LAZY_BIN;
  hermes.client.proc?.kill("SIGKILL");
  await tick(100);
  try {
    const h = await hermes.hermesAdapter.spawn({ sessionId: "t-lazyid", cwd: "/tmp", resumeRef: "dead-ref" });
    try {
      assert.equal(
        h.harnessRef,
        "hs-fresh-1",
        "the resumed session must run on the id hermes actually reports — never the requested dead ref, never a rejection when the id follows in a session/update",
      );
      assert.equal(h.acpSessionId, "hs-fresh-1");
    } finally {
      hermes.hermesAdapter.dispose(h);
    }
  } finally {
    hermes.client.proc?.kill("SIGKILL");
    cleanup();
  }
});

/* ── 7. a rejected resume leaves no watcher or claim behind (audit B1) ── */

/* fake: answers initialize, then ERRORS the session/resume call */
const REJ_DIR = mkdtempSync(join(tmpdir(), "truss-resrej-"));
const REJ_FAKE = `
let b = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  b += c; let i;
  while ((i = b.indexOf("\\n")) >= 0) {
    const l = b.slice(0, i).trim(); b = b.slice(i + 1);
    if (!l) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (r.id == null || !r.method) continue;
    if (r.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: r.id, result: { protocolVersion: 1 } }) + "\\n");
    else if (r.method === "session/resume") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: r.id, error: { code: -32602, message: "no such session" } }) + "\\n");
    else process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: r.id, result: {} }) + "\\n");
  }
});
`;
writeFileSync(join(REJ_DIR, "rej.cjs"), REJ_FAKE);
const REJ_BIN = join(REJ_DIR, "rej-bin.sh");
writeFileSync(REJ_BIN, `#!/bin/sh\nexec ${process.execPath} ${join(REJ_DIR, "rej.cjs")}\n`, { mode: 0o755 });

test("a resume call that rejects leaves the watcher cancelled and no id claim behind", async () => {
  const { cleanup } = await freshServer("resrej");
  const hermes: any = await import("../src/adapters/hermes.js");
  hermes.client.launch.command = REJ_BIN;
  hermes.client.proc?.kill("SIGKILL");
  await tick(100);
  try {
    await assert.rejects(
      () => hermes.hermesAdapter.spawn({ sessionId: "t-resrej", cwd: "/tmp", resumeRef: "dead-ref" }),
      /no such session/i,
      "the harness's own error surfaces",
    );
    await tick(50);
    assert.equal(
      hermes.client.sessionWatchers.size,
      0,
      "a rejected resume must not leave the watcher armed — its late fire would hold a claim only a future onSession could release",
    );
    assert.equal(hermes.client.watchClaims.size, 0, "no id claim survives the rejection");
  } finally {
    hermes.client.proc?.kill("SIGKILL");
    cleanup();
  }
});

import { after } from "node:test";
after(() => {
  for (const d of [DIR, PISH_DIR, DEATH_DIR, LAZY_DIR, REJ_DIR])
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
});
