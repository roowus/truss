import { test } from "node:test";
import assert from "node:assert/strict";
import { bootServer, type TestServer } from "./server-harness.js";
import type { AdapterHandle, HarnessAdapter } from "../src/adapters/types.js";

/**
 * HTTP-level pin for POST /api/harnesses/probe (issue #101, audit round 2):
 * the probe contract itself is covered by model-catalog.test.ts at the
 * sessions.listModels({ probe }) level; this file pins the ROUTE — a
 * misregistered path would ship green otherwise and surface as a "Could not
 * load harnesses" toast on every dialog open. The real hermes/dsh adapters
 * are swapped for recording fakes (registerAdapter is the seam runtime
 * harnesses plug into) so the probe never spawns a process.
 */

let srv: TestServer;

test.before(async () => {
  srv = await bootServer("harnesses-probe");
});
test.after(async () => {
  await srv?.close();
});

test("GET /api/harnesses stays read-only; POST /api/harnesses/probe probes empty probeable adapters once", async () => {
  const sessions = await import("../src/sessions.js");
  const probes: string[] = [];
  const fake = (id: string): HarnessAdapter => ({
    id: id as never,
    capabilities: { permissions: false, subagents: false, streaming: true, queueWhileRunning: false },
    async listModels() {
      return [];
    },
    async probeModels() {
      probes.push(id);
      return false; /* catalog stays empty — the route pin doesn't need a fill */
    },
    async spawn(): Promise<AdapterHandle> {
      throw new Error("not under test");
    },
    send() {},
    interrupt() {},
    async *events() {
      await new Promise(() => {});
      yield undefined as never;
    },
    dispose() {},
  });
  sessions.registerAdapter("hermes", fake("hermes"));
  sessions.registerAdapter("dsh", fake("dsh"));

  const get = await fetch(`${srv.base}/api/harnesses`);
  assert.equal(get.status, 200);
  const got = await get.json();
  assert.ok(Array.isArray(got.harnesses) && Array.isArray(got.models), "GET shape: {harnesses, models}");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(probes.length, 0, "the plain GET never probes");

  const post = await fetch(`${srv.base}/api/harnesses/probe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(post.status, 200);
  const probed = await post.json();
  assert.ok(Array.isArray(probed.harnesses) && Array.isArray(probed.models), "POST answers with the GET's shape");
  assert.ok(
    probed.harnesses.some((h: { id: string; probeable?: boolean }) => h.id === "hermes" && h.probeable === true),
    "lazy adapters are flagged probeable",
  );
  assert.ok(
    probed.harnesses.some((h: { id: string; probeable?: boolean }) => h.id === "pi" && !h.probeable),
    "pi (static catalog) is not probeable — the dialog never asks on its account",
  );
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(probes.sort(), ["dsh", "hermes"], "the ask reaches every empty probeable adapter once");

  /* audit round 3: text/plain is CORS-safelisted (no preflight) and fastify 5
     parses it by default, so without the content-type gate a cross-site form
     POST could still fire the probe */
  const asForm = await fetch(`${srv.base}/api/harnesses/probe`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "{}",
  });
  assert.equal(asForm.status, 415, "non-JSON content types are refused");
  const noType = await fetch(`${srv.base}/api/harnesses/probe`, { method: "POST" });
  assert.equal(noType.status, 415, "a missing content type is refused");
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(probes.sort(), ["dsh", "hermes"], "refused requests never probe");
});

test("a NON-EMPTY catalog is still handed to the adapter, which decides freshness (issue #232)", async () => {
  /* sessions.listModels no longer gates the probe on `models.length === 0`
     (issue #232): a non-empty but WRONG catalog used to be permanent, because
     nothing ever re-asked the harness. The adapter now owns the decision —
     the in-process lazy catalogs re-probe once their staleness window lapses,
     and remote.probeModels applies the same window (audit B1), so a populated
     remote catalog is NOT re-probed over the tunnel on every dialog open.

     This pins the sessions-level contract: a non-empty catalog still reaches
     probeModels (so a stale one can heal), and the fake's own guard is what
     suppresses redundant probes. */
  const sessions = await import("../src/sessions.js");
  const probes: string[] = [];
  const fake = (id: string): HarnessAdapter => ({
    id: id as never,
    capabilities: { permissions: false, subagents: false, streaming: true, queueWhileRunning: false },
    async listModels() {
      return [{ provider: "p", model: "m", label: "M" }];
    },
    async probeModels() {
      probes.push(id);
      return false;
    },
    async spawn(): Promise<AdapterHandle> {
      throw new Error("not under test");
    },
    send() {},
    interrupt() {},
    dispose() {},
    async *events() {
      await new Promise(() => {});
      yield undefined as never;
    },
  });
  sessions.registerAdapter("hermes", fake("hermes"));
  sessions.registerAdapter("dsh", fake("dsh"));

  const before = probes.length;
  await sessions.listModels({ probe: true });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(
    probes.length - before,
    2,
    "a non-empty catalog must still be offered to the adapter — otherwise a wrong-but-full catalog is permanent (#232)",
  );
});
