import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* SPEC-TESTS for the silent-refusal black hole —
   https://github.com/roowus/truss/issues/97
   ("Sometimes truss chats just straight up don't work"). These FAIL on
   purpose today: they pin the contract a fix must satisfy.

   Proven mechanism (live probe evidence in the issue): hermes-acp answers
   `session/prompt` for a session it doesn't have with an INSTANT fake
   success — `{"stopReason":"refusal"}`, zero content, ~55ms. Truss's
   adapters never look at the result: hermes.ts settles `ok: true` on any
   resolution (main: hermes.ts send(); dsh.ts likewise), so the chat shows an
   empty bubble + a 200 call row — "the chat doesn't work" with no trace.

   The contract (adapters/acp.ts settlement + the hermes/dsh send paths):

   1. A prompt settling with stopReason "refusal" is NOT a silent success:
      the turn fails loudly — llm.call.done with a failure status and a
      message done whose stopReason says the harness refused/never engaged.
   2. An INSTANT, zero-content settle (end_turn with no streamed content in
      suspiciously few ms) gets the same treatment: "the harness returned
      nothing" — a real answer with content is untouched (guard).
   3. The session returns to idle either way (never a wedged busy flag).

   Mechanics: TRUSS_HERMES_BIN points at a fake ACP server (the
   model-resume.test.ts pattern). */

const DIR = mkdtempSync(join(tmpdir(), "truss-refusal-"));
/* fake hermes-acp: normal handshake/new; prompt behavior depends on the env
   MODE baked at spawn: "refusal" answers instantly with a ghost refusal;
   "empty" answers instantly end_turn with no content; "real" streams a chunk
   then end_turn */
const MODE_FILE = join(DIR, "mode");
const FAKE = `
setTimeout(() => process.exit(0), 8000); // never outlive the test file
const fs = require("node:fs");
const MODE_FILE = ${JSON.stringify(join(DIR, "mode"))};
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
    const note = (update) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: r.params?.sessionId, update } }) + "\\n");
    if (r.method === "initialize") reply({ protocolVersion: 1 });
    else if (r.method === "session/new") reply({ sessionId: "fake-sess", models: { availableModels: [{ modelId: "custom:x" }], currentModelId: "custom:x" } });
    else if (r.method === "session/prompt") {
      const MODE = fs.existsSync(MODE_FILE) ? fs.readFileSync(MODE_FILE, "utf8").trim() : "refusal";
      if (MODE === "real") {
        note({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a real answer" } });
        setTimeout(() => reply({ stopReason: "end_turn" }), 60);
      } else if (MODE === "empty") {
        reply({ stopReason: "end_turn" }); /* instant, nothing streamed; no artificial delay — the ghost classification is wall-clock, so any fake delay is flake surface */
      } else {
        setTimeout(() => reply({ stopReason: "refusal" }), 30); /* the ghost black hole */
      }
    }
    else reply({});
  }
});
`;
const FAKE_BIN = join(DIR, "fake-hermes.sh");
writeFileSync(join(DIR, "fake.cjs"), FAKE);
writeFileSync(FAKE_BIN, `#!/bin/sh\nexec ${process.execPath} ${join(DIR, "fake.cjs")}\n`, { mode: 0o755 });
process.env.TRUSS_HERMES_BIN = FAKE_BIN;
process.env.TRUSS_ACP_TIMEOUT_MS = "4000";

const { freshServer } = await import("./helpers.js");

async function run(mode: "refusal" | "empty" | "real") {
  /* one fake process serves all modes: it reads the mode file per prompt */
  const { writeFileSync: w } = await import("node:fs");
  w(join(DIR, "mode"), mode);
  const { cleanup } = await freshServer(`refusal-${mode}`);
  const hermes: any = await import("../src/adapters/hermes.js");
  try {
    const h = await hermes.hermesAdapter.spawn({ sessionId: `t-${mode}`, cwd: "/tmp" });
    const events: any[] = [];
    const drain = (async () => {
      for await (const ev of hermes.hermesAdapter.events(h)) {
        events.push(ev);
        if (ev.type === "llm.call.done") break;
      }
    })();
    hermes.hermesAdapter.send(h, "hi"); // the prompt IS the trigger
    await Promise.race([drain, new Promise((r) => setTimeout(r, 8000))]);
    return { events, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}

function assess(events: any[]) {
  const done = events.find((e) => e.type === "llm.call.done") as any;
  const msgDones = events.filter((e) => e.type === "msg.done") as any[];
  const idle = events.some((e) => e.type === "session.state" && (e as any).state === "idle");
  const text = events.filter((e) => e.type === "msg.chunk" && (e as any).channel !== "thinking").map((e) => (e as any).text).join("");
  return { done, msgDones, idle, text };
}

test("guard: a real turn (content + end_turn) settles as success exactly as today", async () => {
  const { events, cleanup } = await run("real");
  try {
    const { done, text, idle } = assess(events);
    assert.ok(text.includes("a real answer"), "content streamed");
    assert.equal(done?.status, 200, "real turns stay 200");
    assert.ok(idle);
  } finally {
    cleanup();
  }
});


test("a refusal is a loud failure, not a silent 200 — and the session unwedges", async () => {
  const { events, cleanup } = await run("refusal");
  try {
    const { done, msgDones, idle } = assess(events);
    assert.ok(done, "the turn settles");
    assert.ok(done.status >= 400, `a refusal must not settle as 200 — got ${done.status} (today: silent success, the chat looks dead)`);
    assert.ok(
      msgDones.some((m) => /refus|did not engage|never engaged|empty/i.test(String(m?.stopReason ?? ""))),
      "some message close says the harness never engaged",
    );
    assert.ok(idle, "the session returns to idle — no wedged busy flag");
  } finally {
    cleanup();
  }
});

test("an instant zero-content settle is reported as nothing-happened (real content turns are untouched)", async () => {
  const { events, cleanup } = await run("empty");
  try {
    const { done, msgDones, text } = assess(events);
    assert.equal(text, "", "control: the fake streamed nothing");
    assert.ok(done && done.status >= 400, `an instant empty turn is a failure signal — got ${done?.status}`);
    assert.ok(
      msgDones.some((m) => /empty|nothing|no content|did not engage/i.test(String(m?.stopReason ?? ""))),
      "the transcript says so",
    );
  } finally {
    cleanup();
  }
});

import { after } from "node:test";
after(() => {
  try {
    rmSync(DIR, { recursive: true, force: true });
  } catch {}
});
