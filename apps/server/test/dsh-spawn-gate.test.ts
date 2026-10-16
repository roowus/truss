import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* REGRESSION for issue #232 audit B3 — spawn() must not boot dsh before the
   generated catalog is known.

   Generation is fire-and-forget at boot (index.ts) while the server is
   already listening, so a session created in that window used to see
   generatedPatch === null, boot dsh from the static-only --patch args, and
   then write the narrow 27-row report over the good catalog via
   catalog.set(). AcpClient keeps that process alive, so every later spawn and
   the 6h re-probe talked to the already-static-config harness — i.e. the #232
   bug persisted for the whole process lifetime.

   This drives the REAL spawn path (TRUSS_DSH_BIN points at a fake ACP server,
   the documented seam) and proves the ordering behaviourally: the fake logs a
   line the moment it starts, so we can assert dsh has NOT started while the
   generation gate is still pending, and HAS started once it settles. The
   earlier version of this test only grepped the source for the await, which
   would pass on a commented-out line. */

const LOG_DIR = mkdtempSync(join(tmpdir(), "truss-spawn-gate-"));
const BOOT_LOG = join(LOG_DIR, "boot.log");
const DATA_DIR = mkdtempSync(join(tmpdir(), "truss-spawn-gate-data-"));
process.env.TRUSS_DATA_DIR = DATA_DIR;

/* the fake writes a marker file as its very first action — that IS "dsh
   booted", observed from outside the server process */
const FAKE = `
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(BOOT_LOG)}, "booted\\n");
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
    else if (r.method === "session/new") reply({ sessionId: "gate-1", configOptions: [] });
    else if (r.method === "session/close") { reply({}); if (r.params.sessionId === "bye") setTimeout(() => process.exit(0), 100); }
    else reply({});
  }
});
`;
const FAKE_BIN = join(LOG_DIR, "fake-dsh.cjs");
writeFileSync(FAKE_BIN, FAKE);
const WRAPPER = join(LOG_DIR, "fake-dsh-bin.sh");
writeFileSync(WRAPPER, `#!/bin/sh\nexec ${process.execPath} ${FAKE_BIN} "$@"\n`, { mode: 0o755 });

let proc: any;
test.before(async () => {
  process.env.TRUSS_DSH_BIN = WRAPPER;
  process.env.TRUSS_ACP_TIMEOUT_MS = "4000";
  proc = await import("../src/adapters/dsh.js");
});

after(async () => {
  /* the client is a module SINGLETON and its fake child outlives the test
     process otherwise — the suite HANGS rather than fails, which is how the
     first version of this test was caught. The fake exits on session/close
     for the "bye" sentinel (same idiom as dsh-resume.test.ts). */
  try {
    await proc?.client?.call("session/close", { sessionId: "bye" });
  } catch {
    /* best effort */
  }
  await new Promise((r) => setTimeout(r, 250));
  rmSync(LOG_DIR, { recursive: true, force: true });
  rmSync(DATA_DIR, { recursive: true, force: true });
});

const boots = () =>
  existsSync(BOOT_LOG) ? readFileSync(BOOT_LOG, "utf8").split("\n").filter(Boolean).length : 0;

test("spawn() does NOT boot dsh while the generation gate is still pending", async () => {
  /* hold the gate open: this is the boot window the audit describes */
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = () => r();
  });
  proc.markGenerationSettled(gate);

  /* start a real spawn; it must park on the gate, not boot the harness */
  const spawned = proc.dshAdapter
    .spawn({ sessionId: "gate-sess", cwd: "/tmp", harness: "dsh" })
    .catch(() => null);

  /* give the spawn every chance to boot the fake if the await were missing */
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(boots(), 0, "dsh must NOT boot while generation is still pending (audit B3)");

  /* release the gate — now the harness may boot */
  release();
  await spawned;
  assert.ok(boots() >= 1, "once the gate settles, spawn proceeds and boots the harness");
});
