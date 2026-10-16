import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

/* ── audit round 3, B3: the STORE branch, not just the pure helpers ──────
 *
 * The report was right that nothing drove a `health.snapshot` FRAME — a
 * regression in the store's handling would have shipped green. These feed a
 * real frame through the store's exported pure reducer and then assert the
 * rendered result, closing the loop the issue's fourth test asks for. */
test("a health.snapshot frame reaches app state and renders", async () => {
  const { healthFramePatch } = await import("../src/lib/health");

  const payload: HealthSnapshot = {
    commit: "abc1234",
    version: "0.1.0",
    bind: "0.0.0.0:4040",
    dataDir: "/var/lib/truss",
    state: "degraded",
    time: 1_700_000_000_000,
    subsystems: [
      { name: "store", state: "ok", detail: "sqlite open" },
      { name: "adapter:hermes", state: "degraded", detail: "not found on PATH: hermes-acp" },
    ],
  };

  const patch = healthFramePatch({ health: payload });
  assert.ok(patch, "a well-formed frame produces a patch");
  assert.deepEqual(patch!.health, payload, "the client stores the server-authoritative snapshot VERBATIM");

  /* the dot and the rows render from exactly what the frame carried */
  assert.equal(healthDotState(patch!.health), "degraded", "the status bar dot reflects the frame");
  const rows = healthRows(patch!.health);
  assert.deepEqual(rows.map((r) => r.name).sort(), ["adapter:hermes", "store"], "every subsystem in the frame renders");
  assert.equal(rows[0].name, "adapter:hermes", "the degraded row sorts first so the reason is read first");
});

test("a malformed health frame never blanks a good snapshot", async () => {
  const { healthFramePatch } = await import("../src/lib/health");
  /* dropping a good snapshot because a bad frame arrived would leave the dot
     stuck on "unknown" — the client keeps what it has instead */
  assert.equal(healthFramePatch({}), null, "no health field → no patch");
  assert.equal(healthFramePatch({ health: undefined }), null, "undefined → no patch");
  assert.equal(healthFramePatch({ health: { subsystems: "nope" } as never }), null, "non-array subsystems → no patch");
});

/* ── audit round 5, B1: the dot must populate on a NORMAL page load ──────
 *
 * The bug: refreshHealth() existed but its only caller was resync(), which
 * is gated behind a RECONNECT (onConn skips it on the first open). So a tab
 * opened against an already-running server showed a grey "unknown" dot and
 * "No snapshot yet" until some remote host happened to drop — forever, on a
 * single-host setup with no agents at all. The event push cannot cover this:
 * the server broadcasts health.snapshot at boot (before any client can
 * connect) and only thereafter on the agents.changed edge.
 *
 * These are source-level pins, because the store's boot batch needs the full
 * backend + window to run for real. They assert the structural property the
 * fix establishes, in the same spirit as the no-spawn probe pin. */
test("the store's init batch actually fetches health (B1 regression pin)", () => {
  const src = readFileSync(new URL("../src/lib/store.ts", import.meta.url), "utf8");
  const initBody = src.slice(src.indexOf("async init("), src.indexOf("async resync()"));
  assert.ok(initBody.length > 0, "found the init method");
  assert.match(
    initBody,
    /refreshHealth\(\)/,
    "init() must fetch the readiness report — otherwise the dot stays 'unknown' on a normal page load (audit round 5 B1)",
  );
});

test("the demo backend PUSHES a health frame, so demo mode is not stuck grey", () => {
  const src = readFileSync(new URL("../src/lib/demo.ts", import.meta.url), "utf8");
  const conn = src.slice(src.indexOf("connectEvents(onFrame"), src.indexOf("connectTerminal"));
  assert.match(
    conn,
    /health\.snapshot/,
    "demo mode emits no agents.changed edge, so connectEvents must push a health frame itself (audit round 5 B1)",
  );
});

/* ── audit round 6: formatting hygiene guards ────────────────────────────
 *
 * Two rounds in a row, careless edits left (a) a class declaration collapsed
 * onto its field line and (b) duplicated/orphaned doc comments. Lint catches
 * neither. These are cheap structural guards over the files this feature
 * owns, so the same regression cannot land a third time. */
test("no stacked duplicate doc comments in the health files", () => {
  const files = [
    "../src/lib/health.ts",
    "../src/lib/store.ts",
    "../src/lib/demo.ts",
  ];
  for (const rel of files) {
    const lines = readFileSync(new URL(rel, import.meta.url), "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trimStart().startsWith("/**")) continue;
      let j = i;
      while (j < lines.length && !lines[j].includes("*/")) j++;
      let k = j + 1;
      while (k < lines.length && lines[k].trim() === "") k++;
      assert.ok(
        !(k < lines.length && lines[k].trimStart().startsWith("/**")),
        `${rel}:${i + 1} has a doc comment immediately followed by another (an orphaned duplicate)`,
      );
      i = j;
    }
  }
});

test("the Store class body is not collapsed onto its declaration line", () => {
  const src = readFileSync(new URL("../src/lib/store.ts", import.meta.url), "utf8");
  assert.ok(
    !/class Store \{[^\n]*state:/.test(src),
    "class Store collapsed onto one line with its first field — a formatting regression lint misses",
  );
  assert.match(src, /class Store \{\n\s+state: AppState = \{/, "the class declaration and its state field are on separate lines");
});
