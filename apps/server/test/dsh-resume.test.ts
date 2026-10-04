import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* dsh sibling coverage for issue #14 (the hermes contract in
   model-resume.test.ts, same shape with configOptions): resume must read the
   response — refresh the model catalog, honor the requested model via
   session/set_config_option, and adopt a rehomed session id.

   TRUSS_DSH_BIN (added with the fix) points at a fake ACP server. The client
   is a module singleton, so one fake serves the whole file; it exits when
   session/close arrives for "bye" (triggered by the last test). */

const LOG_DIR = mkdtempSync(join(tmpdir(), "truss-fake-dsh-"));
const LOG = join(LOG_DIR, "set-config.log");

/* the adapter now persists its discovered catalog to kv (issue #101) —
   isolate the DB before the import below opens it */
const DATA_DIR = mkdtempSync(join(tmpdir(), "truss-test-dsh-resume-data-"));
process.env.TRUSS_DATA_DIR = DATA_DIR;

const CATALOG = {
  configOptions: [
    {
      id: "model",
      currentValue: '["deepseek","deepseek-chat"]',
      options: [
        { name: "DeepSeek Chat", value: '["deepseek","deepseek-chat"]' },
        { name: "DeepSeek Reasoner", value: '["deepseek","deepseek-reasoner"]' },
      ],
    },
  ],
};

const FAKE = `
const fs = require("node:fs");
const log = (m) => fs.appendFileSync(${JSON.stringify(LOG)}, m + "\\n");
const CATALOG = ${JSON.stringify(CATALOG)};
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
    else if (r.method === "session/new") reply({ sessionId: "fresh-1", ...CATALOG });
    else if (r.method === "session/resume") reply({ sessionId: r.params.sessionId === "rehome-me" ? "sess-new-home" : r.params.sessionId, ...CATALOG });
    else if (r.method === "session/set_config_option") { log(JSON.stringify(r.params)); reply({}); }
    else if (r.method === "session/close") { reply({}); if (r.params.sessionId === "bye") setTimeout(() => process.exit(0), 100); }
    else reply({});
  }
});
`;

const FAKE_BIN = join(LOG_DIR, "fake-dsh.cjs");
writeFileSync(FAKE_BIN, FAKE);
const WRAPPER = join(LOG_DIR, "fake-dsh-bin.sh");
writeFileSync(WRAPPER, `#!/bin/sh\nexec ${process.execPath} ${FAKE_BIN} "$@"\n`, { mode: 0o755 });
process.env.TRUSS_DSH_BIN = WRAPPER;

const dsh: any = await import("../src/adapters/dsh.js");

const setConfigCalls = (): { sessionId?: string; configId?: string; value?: string }[] =>
  existsSync(LOG) ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

test("spawn(resumeRef, model) issues set_config_option for the requested model", async () => {
  const h = await dsh.dshAdapter.spawn({ sessionId: "d-resume", cwd: "/tmp", model: "deepseek-reasoner", resumeRef: "sess-old-9" });
  assert.ok(h);
  await new Promise((r) => setTimeout(r, 300));
  const calls = setConfigCalls();
  assert.ok(
    calls.some((c) => c.sessionId === "sess-old-9" && c.configId === "model" && c.value === '["deepseek","deepseek-reasoner"]'),
    `the requested model must reach the resumed session. Got: ${JSON.stringify(calls)}`,
  );
});

test("a resume response's configOptions refresh the discovered catalog", async () => {
  const models = await dsh.dshAdapter.listModels();
  assert.ok(models.some((m: any) => m.model === "deepseek-reasoner"), `catalog refreshed from resume: ${JSON.stringify(models)}`);
});

test("guard: unknown model is never forced (no set_config_option, no crash)", async () => {
  const before = setConfigCalls().length;
  await dsh.dshAdapter.spawn({ sessionId: "d-unknown", cwd: "/tmp", model: "nope-model" });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(setConfigCalls().length, before);
});

test("a resume that returns a DIFFERENT session id must be adopted", async () => {
  const h = await dsh.dshAdapter.spawn({ sessionId: "d-rehome", cwd: "/tmp", resumeRef: "rehome-me" });
  assert.equal(h.harnessRef, "sess-new-home", "later calls must target the session the harness actually resumed under");
});

test("cleanup: sentinel close lets the fake exit", async () => {
  const h = await dsh.dshAdapter.spawn({ sessionId: "d-bye", cwd: "/tmp", resumeRef: "bye" });
  dsh.dshAdapter.dispose(h);
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(true);
});

after(() => {
  try {
    rmSync(LOG_DIR, { recursive: true, force: true });
    rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {}
});
