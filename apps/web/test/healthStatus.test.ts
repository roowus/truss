import { test } from "node:test";
import assert from "node:assert/strict";
import { HEALTH_META, healthDotState, healthRollup, healthRows, healthSummary } from "../src/lib/health";
import type { HealthSnapshot, SubsystemHealth } from "../src/lib/proto";

/* SPEC-TEST for the status-bar rendering contract — issue #219.
 *
 * The issue's fourth test: "health payload matches what the status bar
 * renders (web reducer test)". The status bar's dot and its popover both
 * derive from the pure helpers in src/lib/health.ts, so this pins the exact
 * payload → rendered-rows mapping WITHOUT a DOM — which is what makes it a
 * reducer test rather than a snapshot of React output.
 */

const snap = (subsystems: SubsystemHealth[], state?: HealthSnapshot["state"]): HealthSnapshot => ({
  commit: "abc1234",
  version: "0.2.0",
  bind: "0.0.0.0:4040",
  dataDir: "/var/lib/truss",
  state: state ?? healthRollup(subsystems),
  time: 1_700_000_000_000,
  subsystems,
});

const OK_ROW: SubsystemHealth = { name: "store", state: "ok", detail: "sqlite open" };

test("the dot is the worst subsystem state, and the rows say the same thing", () => {
  /* a degraded adapter does NOT make the server green, and does not make it
     red either — "works with less" is its own honest state */
  const payload = snap([
    OK_ROW,
    { name: "adapter:pi", state: "ok", detail: "/usr/bin/pi" },
    { name: "adapter:hermes", state: "degraded", detail: "not found on PATH: hermes-acp" },
  ]);
  assert.equal(healthDotState(payload), "degraded", "one degraded adapter → amber dot, not green");

  const rows = healthRows(payload);
  assert.equal(rows.length, payload.subsystems.length, "every subsystem the payload carries is rendered");
  assert.deepEqual(
    rows.map((r) => r.name).sort(),
    payload.subsystems.map((s) => s.name).sort(),
    "the popover lists exactly the payload's subsystem names — no invented and no dropped rows",
  );
  /* the detail text reaches the UI verbatim */
  const hermes = rows.find((r) => r.name === "adapter:hermes")!;
  assert.equal(hermes.detail, "not found on PATH: hermes-acp", "the WHY is rendered, not just the state");
  assert.equal(hermes.label, HEALTH_META.degraded.label, "the row's word matches the dot's vocabulary");
});

test("down outranks degraded, and is what the dot shows", () => {
  const payload = snap([
    { name: "adapter:pi", state: "degraded", detail: "missing" },
    { name: "store", state: "down", detail: "store unusable" },
  ]);
  assert.equal(healthDotState(payload), "down", "a down subsystem outranks a degraded one");
  /* the reason for a red dot is the FIRST row read, not buried */
  const rows = healthRows(payload);
  assert.equal(rows[0].name, "store", "down/degraded rows sort above ok rows");
  assert.equal(rows[0].state, "down");
});

test("no snapshot is 'unknown', never a green dot", () => {
  /* we do not claim health we have not been told about */
  assert.equal(healthDotState(null), "unknown");
  assert.notEqual(HEALTH_META.unknown.color, HEALTH_META.ok.color, "unknown must not render as healthy");
  assert.deepEqual(healthRows(null), [], "no rows to render without a payload");
  assert.equal(healthSummary(null), "no snapshot yet");
});

test("healthRollup is pure and total: empty is ok, unknown is NOT ok", () => {
  assert.equal(healthRollup([]), "ok", "an empty list must return a DEFINED value (ok), never undefined");
  assert.equal(healthRollup([{ state: "ok" }]), "ok");
  assert.equal(healthRollup([{ state: "ok" }, { state: "degraded" }]), "degraded");
  assert.equal(healthRollup([{ state: "degraded" }, { state: "down" }]), "down", "worst wins");
  assert.equal(healthRollup([{ state: "ok" }, { state: "down" }, { state: "degraded" }]), "down", "order-independent");
  assert.notEqual(healthRollup([{ state: "banana" }]), "ok", "an unknown state must NOT rank as ok");
  assert.equal(healthRollup([{ state: "ok" }, { state: "banana" }]), "down", "unknown ranks as the worst case");
});

test("the summary counts match the rows that are rendered", () => {
  const payload = snap([
    OK_ROW,
    { name: "a", state: "ok" },
    { name: "b", state: "degraded", detail: "x" },
    { name: "c", state: "down", detail: "y" },
  ]);
  const rows = healthRows(payload);
  assert.equal(rows.filter((r) => r.state === "ok").length, payload.subsystems.filter((s) => s.state === "ok").length);
  assert.equal(rows.filter((r) => r.state === "degraded").length, 1);
  assert.equal(rows.filter((r) => r.state === "down").length, 1);
  assert.equal(healthSummary(payload), "2 ok · 1 degraded · 1 down", "the popover header counts what is listed");
});

test("an unrecognized state from the server does not render as healthy", () => {
  /* forward compatibility WITHOUT dishonest rendering: a state string this
     build does not know must not show up green */
  const payload = snap([{ name: "future", state: "who-knows" as never, detail: "?" }]);
  assert.equal(healthDotState(payload), "down", "an unknown state is treated as the worst case");
  const rows = healthRows(payload);
  assert.equal(rows.length, 1, "the row is still rendered — we do not hide what we do not understand");
  assert.notEqual(rows[0].label, HEALTH_META.ok.label, "and it does not wear the healthy label");
});
