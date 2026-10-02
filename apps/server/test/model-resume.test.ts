import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* SPEC-TESTS for model switching being dropped on ACP resume —
   https://github.com/roowus/truss/issues/14
   ("No matter what model I pick, prompting fails 'billing exhausted for
   glm-4.7'"). These pin the contract the issue demanded; the fix landed
   with them, so they pass.

   Root cause: hermesAdapter.spawn's resume branch (adapters/hermes.ts:93-100)
   DISCARDS the session/resume response, so res.models is always undefined —
   and the "honor the requested model" block (lines 118-123) is gated on
   res.models. Every model switch goes through that branch: switchModel
   dispose+respawns with resumeRef whenever the session has a harness_ref
   (sessions.ts:280-286), i.e. always. The harness keeps booting its default
   (glm-4.7 → the exhausted account) no matter what was picked. dsh.ts:140-166
   has the same shape with configOptions.

   The contract (hermes side; dsh noted in the issue — it needs a
   TRUSS_DSH_BIN env override to become testable, then shares this):

   - spawn with resumeRef + a requested model that IS in the resumed
     session's catalog MUST issue session/set_model for it. (Today: never.)
   - a resume response carrying model state refreshes the adapter's
     discovered catalog (listModels) — today the catalog only ever updates
     from session/new.
   - regression guards (green today): a fresh session/new with a cataloged
     model still switches; a model absent from the catalog is never forced
     (no set_model, no crash).

   Mechanics: TRUSS_HERMES_BIN points at a fake ACP server (a node fixture)
   that answers initialize/session-new/session-resume/session-set_model and
   LOGS every set_model to $FAKE_ACP_LOG for assertions. The adapter's client
   is a module singleton, so this file drives one fake server across its
   tests; the fake exits when session/close arrives for the id "bye", which
   the last test triggers via dispose() so the test process can exit. */

const LOG_DIR = mkdtempSync(join(tmpdir(), "truss-fake-acp-"));
const LOG = join(LOG_DIR, "set-model.log");

/* the fake hermes-acp: NDJSON ACP over stdio; answers initialize, session/new
   and session/resume (both carrying a two-model catalog, current = glm-4.7),
   logs every session/set_model, rehomes the magic resumeRef "rehome-me" (as
   hermes does when the persisted session is gone: probe showed resume
   silently creating a NEW session under a different id), and exits on
   session/close for "bye" */
const FAKE = `
const fs = require("node:fs");
const log = (m) => fs.appendFileSync(${JSON.stringify(LOG)}, m + "\\n");
const MODELS = { models: { availableModels: [
  { modelId: "custom:glm-4.7", name: "Custom endpoint · glm-4.7" },
  { modelId: "custom:glm-4.6", name: "Custom endpoint · glm-4.6" },
], currentModelId: "custom:glm-4.7" } };
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
    else if (r.method === "session/new") reply({ sessionId: "fresh-1", ...MODELS });
    else if (r.method === "session/resume") reply({ sessionId: r.params.sessionId === "rehome-me" ? "sess-new-home" : r.params.sessionId, ...MODELS });
    else if (r.method === "session/set_model") { log(JSON.stringify(r.params)); reply({}); }
    else if (r.method === "session/close") { reply({}); if (r.params.sessionId === "bye") setTimeout(() => process.exit(0), 100); }
    else reply({});
  }
});
`;

const FAKE_BIN = join(LOG_DIR, "fake-hermes.cjs");
writeFileSync(FAKE_BIN, FAKE);
process.env.TRUSS_HERMES_BIN = `${process.execPath} ${FAKE_BIN}`;

/* hermes.ts builds its client at import time from TRUSS_HERMES_BIN — but the
   command is spawned via child_process.spawn(command, args) with no shell, so
   the env must be the binary alone: use a wrapper script. */
const WRAPPER = join(LOG_DIR, "fake-hermes-bin.sh");
writeFileSync(WRAPPER, `#!/bin/sh\nexec ${process.execPath} ${FAKE_BIN} "$@"\n`, { mode: 0o755 });
process.env.TRUSS_HERMES_BIN = WRAPPER;

const hermes: any = await import("../src/adapters/hermes.js");

const setModelCalls = (): { sessionId?: string; modelId?: string }[] =>
  existsSync(LOG)
    ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

test("spawn(resumeRef, model) issues session/set_model for the requested model — today it never does", async () => {
  const h = await hermes.hermesAdapter.spawn({ sessionId: "t-resume", cwd: "/tmp", model: "custom:glm-4.6", resumeRef: "sess-old-1" });
  assert.ok(h, "spawn resolves");
  await new Promise((r) => setTimeout(r, 300)); // let the fire-and-forget set_model land
  const calls = setModelCalls();
  assert.ok(
    calls.some((c) => c.sessionId === "sess-old-1" && c.modelId === "custom:glm-4.6"),
    `expected session/set_model custom:glm-4.6 on the RESUMED session — the switch the user asked for. Got: ${JSON.stringify(calls)}`,
  );
});

test("a resume response's model state refreshes the discovered catalog", async () => {
  const models = await hermes.hermesAdapter.listModels();
  assert.ok(
    models.some((m: any) => m.model === "custom:glm-4.6"),
    `resume returned a catalog — listModels should reflect it. Got: ${JSON.stringify(models)}`,
  );
});

test("guard (green today): fresh session/new with a cataloged model switches in place", async () => {
  await hermes.hermesAdapter.spawn({ sessionId: "t-new", cwd: "/tmp", model: "custom:glm-4.7" });
  await new Promise((r) => setTimeout(r, 300));
  const calls = setModelCalls();
  assert.ok(
    calls.some((c) => c.sessionId === "fresh-1" && c.modelId === "custom:glm-4.7"),
    "the fresh-spawn path already honors requested models — keep it",
  );
});

test("guard: a model the catalog lacks is never forced (no set_model, no crash)", async () => {
  const before = setModelCalls().length;
  await hermes.hermesAdapter.spawn({ sessionId: "t-unknown", cwd: "/tmp", model: "custom:no-such-model" });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(setModelCalls().length, before, "unknown model → no set_model issued");
});

test("a resume that returns a DIFFERENT session id must be adopted (hermes creates a fresh session when the persisted one is gone)", async () => {
  /* probe evidence: resume of a missing session made hermes mint
     438cae92-… while the client kept addressing the dead id — every later
     set_model/prompt whispered into the void ("model switch requested for
     missing session" in hermes's own log) */
  const h = await hermes.hermesAdapter.spawn({ sessionId: "t-rehome", cwd: "/tmp", resumeRef: "rehome-me" });
  assert.equal(h.harnessRef, "sess-new-home", "adopt the id the harness actually resumed under — or every later call targets a ghost");
});

test("cleanup: close the sentinel session so the fake server exits", async () => {
  const h = await hermes.hermesAdapter.spawn({ sessionId: "t-bye", cwd: "/tmp", resumeRef: "bye" });
  hermes.hermesAdapter.dispose(h);
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(true);
});

import { after } from "node:test";
after(() => {
  try {
    rmSync(LOG_DIR, { recursive: true, force: true });
  } catch {}
});
