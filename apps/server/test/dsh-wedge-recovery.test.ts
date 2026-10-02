import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* Issue #12 regression, adapter level: a session/new that outlives its budget
   means the multiplexed ACP server is wedged (the 10m03s hermes repro). The
   spawn must reject fast AND kill the server — otherwise ensure() keeps
   returning the stuck process and every retry wedges on it again (the
   "silent multiplier"). The retry must boot a FRESH child.

   TRUSS_DSH_BIN points at a fake that answers initialize and nothing else;
   TRUSS_ACP_TIMEOUT_MS shrinks the budget so the wedge takes 300ms, not 60s.
   Both are process-env hooks read at call time. The client is a module
   singleton, so this file gets the whole wedge scenario to itself. */

const DIR = mkdtempSync(join(tmpdir(), "truss-fake-dsh-wedge-"));
const BOOTS = join(DIR, "boots.log");

/* answers initialize, pends everything else — the wedged harness. Logs its
   pid at boot so the test can prove the retry got a NEW process. The
   error/exit listeners keep a broken pipe from crashing the fake before the
   wedge can play out. */
const FAKE = `
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(BOOTS)}, "boot " + process.pid + "\\n");
process.stdin.on("error", () => {});
process.stdout.on("error", () => {});
let b = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  b += c; let i;
  while ((i = b.indexOf("\\n")) >= 0) {
    const l = b.slice(0, i).trim(); b = b.slice(i + 1);
    if (!l) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (r.id != null && r.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: r.id, result: { protocolVersion: 1 } }) + "\\n");
    }
  }
});
`;

const FAKE_BIN = join(DIR, "fake-dsh-wedge.cjs");
writeFileSync(FAKE_BIN, FAKE);
const WRAPPER = join(DIR, "fake-dsh-bin.sh");
writeFileSync(
  WRAPPER,
  `#!/bin/sh\n${process.execPath} ${FAKE_BIN} "$@" 2>>${join(DIR, "stderr.log")}\necho "exit $?" >> ${join(DIR, "exit.log")}\n`,
  { mode: 0o755 },
);
process.env.TRUSS_DSH_BIN = WRAPPER;
process.env.TRUSS_ACP_TIMEOUT_MS = "300";

const dsh: any = await import("../src/adapters/dsh.js");

const bootPids = (): string[] =>
  existsSync(BOOTS)
    ? readFileSync(BOOTS, "utf8").trim().split("\n").filter((l) => l.startsWith("boot ")).map((l) => l.slice(5))
    : [];

test("a wedged session/new rejects fast, kills the server, and the retry boots a fresh one", async () => {
  await assert.rejects(
    dsh.dshAdapter.spawn({ sessionId: "wedge-1", cwd: "/tmp" }),
    /timed ?out/i,
    "the wedge fails fast instead of pending for ten minutes",
  );
  const after1 = bootPids();
  assert.equal(after1.length, 1, "one server booted");

  await assert.rejects(dsh.dshAdapter.spawn({ sessionId: "wedge-2", cwd: "/tmp" }), /timed ?out/i);
  const after2 = bootPids();
  assert.equal(after2.length, 2, "the retry did not pile onto the wedged process");
  assert.notEqual(after2[1], after2[0], "the retry booted a FRESH server — the wedged one was killed");
});

after(() => {
  try {
    if (existsSync(join(DIR, "stderr.log"))) console.log("CHILD STDERR:\n" + readFileSync(join(DIR, "stderr.log"), "utf8"));
    if (existsSync(join(DIR, "exit.log"))) console.log("CHILD EXITS:\n" + readFileSync(join(DIR, "exit.log"), "utf8"));
    if (existsSync(BOOTS)) console.log("BOOTS:\n" + readFileSync(BOOTS, "utf8"));
    rmSync(DIR, { recursive: true, force: true });
  } catch {}
});
