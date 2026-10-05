import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { freshServer } from "./helpers.js";

/* REGRESSION (found in PR #113 preview testing): the bundled node-agent
   crashed at boot with `ReferenceError: __filename is not defined in ES
   module scope` — the dsh/hermes adapters' model-catalog cache statically
   imported the server's db.js, dragging better-sqlite3 (a NATIVE module —
   its bindings can never work inside an esbuild bundle) into the agent's
   boot path. The catalog store is now soft: dynamically imported, with a
   memory-only fallback when no database exists in the process.

   This test boots the REAL bundle (built by ensureAgentBundle, the same
   artifact the install script ships) with an unreachable server and asserts
   it gets past module init to its boot banner — the dial failing is fine,
   crashing on a native import is not. */

test("the bundled node-agent boots: no sqlite in its boot path", async (t) => {
  const { cleanup } = await freshServer("agent-boot");
  try {
    const bundle = await import("../src/agentbundle.js");
    await bundle.ensureAgentBundle(); // the real esbuild bundle, in the fresh data dir
    const bin = join(process.env.TRUSS_DATA_DIR!, "agent-bundle.mjs");

    const child = spawn(process.execPath, [bin], {
      env: {
        ...process.env,
        TRUSS_SERVER: "ws://127.0.0.1:1", // nothing listens there — the dial fails, that is fine
        TRUSS_HOST_ID: "boot-test",
        TRUSS_AGENT_TOKEN: "truss_agent_deadbeef",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => child.kill("SIGKILL"));
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    await new Promise((r) => setTimeout(r, 5000));
    const aliveAt5s = child.exitCode === null;
    child.kill("SIGKILL");

    assert.ok(
      aliveAt5s,
      `the agent is a daemon: healthy = still retrying the dead dial after 5s — it exited (${child.exitCode}) with stderr: ${err.slice(0, 400)}`,
    );
    assert.ok(!/ReferenceError|ES module scope|bindings|better.sqlite/i.test(err), `no module-load crash — stderr: ${err.slice(0, 300)}`);
    assert.ok(
      out.includes("[node-agent] host boot-test"),
      `the agent got past module init to its boot banner — stdout: ${out.slice(0, 300)} stderr: ${err.slice(0, 300)}`,
    );
  } finally {
    cleanup();
  }
});
