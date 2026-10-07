import { test } from "node:test";
import assert from "node:assert/strict";

/* Pins for the monitor history ring (issue #168, audit round 3 B2): the cap
   the 60m range selector depends on, the fast-poll dedupe, and the
   snapshot → point mapping's tolerance for older agents' thinner payloads. */

import { createMetricsHistory, histPointOf, HISTORY_CAP, HISTORY_MIN_GAP_MS } from "../src/metricsHistory.js";

test("ring caps at HISTORY_CAP, keeping the newest points in order", () => {
  const h = createMetricsHistory();
  for (let i = 0; i < HISTORY_CAP + 100; i++) {
    h.push("local", { t: i * 3000, cpu: i, mem: 0, rx: 0, tx: 0 });
  }
  const ring = h.get("local");
  assert.equal(ring.length, HISTORY_CAP, "the 60m ring never exceeds its cap");
  assert.equal(ring[ring.length - 1].cpu, HISTORY_CAP + 99, "newest point kept");
  assert.equal(ring[0].cpu, 100, "oldest points dropped in order");
  for (let i = 1; i < ring.length; i++) assert.ok(ring[i].t > ring[i - 1].t, "timestamps strictly increasing");
});

test("polls faster than the min gap collapse instead of double-sampling", () => {
  const h = createMetricsHistory();
  h.push("local", { t: 10_000, cpu: 1, mem: 0, rx: 0, tx: 0 });
  h.push("local", { t: 10_000 + HISTORY_MIN_GAP_MS - 1, cpu: 2, mem: 0, rx: 0, tx: 0 });
  assert.equal(h.get("local").length, 1, "the fast follow-up is dropped");
  h.push("local", { t: 10_000 + HISTORY_MIN_GAP_MS, cpu: 3, mem: 0, rx: 0, tx: 0 });
  assert.equal(h.get("local").length, 2, "a poll at the gap lands");
});

test("keys are independent rings; unknown key reads as empty", () => {
  const h = createMetricsHistory();
  h.push("a", { t: 1, cpu: 1, mem: 0, rx: 0, tx: 0 });
  h.push("b", { t: 1, cpu: 2, mem: 0, rx: 0, tx: 0 });
  assert.equal(h.get("a")[0].cpu, 1);
  assert.equal(h.get("b")[0].cpu, 2);
  assert.deepEqual(h.get("never-seen"), []);
});

test("histPointOf: maps a snapshot, tolerates older agents omitting sections", () => {
  const full = histPointOf({
    at: 123,
    cpu: { usage: 42.5 },
    mem: { total: 1000, used: 250 },
    net: [
      { rxBps: 100, txBps: 40 },
      { rxBps: 60, txBps: 10 },
    ],
  });
  assert.deepEqual(full, { t: 123, cpu: 42.5, mem: 25, rx: 160, tx: 50 });

  const thin = histPointOf({ at: 9 }); // an old agent: no cpu/mem/net at all
  assert.deepEqual(thin, { t: 9, cpu: 0, mem: 0, rx: 0, tx: 0 }, "missing sections degrade to 0, never NaN");
});
