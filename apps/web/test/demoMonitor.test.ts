import { test } from "node:test";
import assert from "node:assert/strict";
import { createDemoBackend } from "../src/lib/demo";

/* the demo backend's monitor fixture against the schema the table renders */

/* The monitor panel renders the backend object with no normalization, so a
   proc entry missing user / memPct / threads / ageSec prints blank cells and
   "NaNm" in the age column — and ?demo is the first thing a newcomer opens
   (it is also the fallback when no server answers). proto made those four
   fields required on every entry; this pins the fixture to the same
   contract. */

test("demo metrics: every proc row carries user, memPct, threads and ageSec", async () => {
  const be = createDemoBackend();
  const m = await be.metrics();
  const entries = [m.local, ...Object.values(m.agents)];
  assert.ok(entries.length >= 2, "the fixture ships the local host plus at least one agent");
  for (const entry of entries) {
    if (!entry) continue;
    assert.ok(entry.metrics.procs.length > 0, `${entry.hostname}: proc rows exist`);
    for (const p of entry.metrics.procs) {
      assert.ok(typeof p.user === "string" && p.user.length > 0, `${entry.hostname} pid ${p.pid}: user is a login name, not blank`);
      assert.ok(Number.isFinite(p.memPct) && p.memPct >= 0, `${entry.hostname} pid ${p.pid}: memPct is a number`);
      assert.ok(Number.isInteger(p.threads) && p.threads > 0, `${entry.hostname} pid ${p.pid}: threads is a count`);
      assert.ok(Number.isFinite(p.ageSec) && p.ageSec >= 0, `${entry.hostname} pid ${p.pid}: ageSec is a number (age renders fmtUptime(ageSec))`);
    }
  }
});
