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

import { after } from "node:test";
after(() => {
  for (const d of [DIR, PISH_DIR])
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
});
