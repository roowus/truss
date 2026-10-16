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

/* ── audit round 5, B1 → round 9, B2: the dot must populate on a NORMAL
 * page load ─────────────────────────────────────────────────────────────
 *
 * The bug: refreshHealth() existed but its only caller was resync(), which
 * is gated behind a RECONNECT, so a tab opened against an already-running
 * server showed a grey "unknown" dot until some remote host happened to
 * drop — forever on a single-host setup. The server cannot cover it: the
 * snapshot goes out at boot (before any client can connect) and thereafter
 * only on the agents.changed edge.
 *
 * Round 9 replaced the original readFileSync/regex pins with the REAL
 * behavioural test at the bottom of this file ("init() fetches health
 * through the backend seam, and a frame drives the dot"), which exercises
 * init()'s boot batch and the store's own onFrame dispatch. The source
 * scans were narrower than they claimed (a moved call stayed green), so
 * they are gone rather than kept alongside. */

/* ── audit round 6: formatting hygiene guards ────────────────────────────
 *
 * Two rounds in a row, careless edits left (a) a class declaration collapsed
 * onto its field line and (b) duplicated/orphaned doc comments. Lint catches
 * neither. These are cheap structural guards over the files this feature
 * owns, so the same regression cannot land a third time. */
test("no stacked duplicate doc comments in the health files", () => {
  /* Audit round 7, B1: this guard originally covered only the three web
     files, but the duplicated/orphaned doc comments it exists to prevent
     actually lived in the SERVER health files (the orphaned probeHosts
     block, the duplicated probeTranscribe block). It claims to walk "the
     feature's files", so it must include them. */
  const files = [
    "../src/lib/health.ts",
    "../src/lib/store.ts",
    "../src/lib/demo.ts",
    "../src/components/Chrome.tsx",
    "../../server/src/health.ts",
    "../../server/src/health-snapshot.ts",
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

test("no em dashes in this feature's user-facing copy (TRUSS.md)", () => {
  /* TRUSS.md: "No em dashes in user-facing copy." Comments are exempt; the
     strings the user reads are not.

     Audit round 8, B1: the first cut scanned only lib/health.ts, yet the
     em-dash fixes themselves landed in Chrome.tsx and health-snapshot.ts,
     and the popover renders SERVER-authored `detail` strings verbatim — so a
     server string with an em dash reaches the user without being inspected.

     Scope: every file this feature contributes user-visible copy to, but
     only for strings that plausibly belong to THIS feature. Chrome.tsx and
     the server health module predate the PR and contain unrelated copy with
     em dashes (e.g. the pre-existing "Event bus connected — ..." tooltip);
     failing on those would be a drive-by change outside this issue's scope.
     A dedicated list keeps the guard honest about what it pins. */
  const FEATURE_STRINGS: { file: string; allow: RegExp }[] = [
    { file: "../src/lib/health.ts", allow: /./ },
    { file: "../../server/src/health-snapshot.ts", allow: /./ },
    { file: "../../server/src/health.ts", allow: /./ },
    { file: "../src/components/Chrome.tsx", allow: /Server health|No snapshot yet/ },
  ];
  for (const { file, allow } of FEATURE_STRINGS) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const line of src.split("\n")) {
      const trimmed = line.trim();
      // skip comment lines — the rule is about copy the user reads
      if (trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed.startsWith("//")) continue;
      const segments = line.match(/"([^"]*)"|`([^`]*)`|>([^<>{]*)</g) ?? [];
      for (const seg of segments) {
        if (!allow.test(seg)) continue;
        assert.ok(
          !seg.includes("—"),
          `${file}: em dash in user-facing copy: ${seg.trim()} (TRUSS.md bans it)`,
        );
      }
    }
  }
});

/* ── audit round 9, B2: drive the REAL store, not a source scan ──────────
 *
 * The earlier pins for "init() fetches health" and "the demo pushes a frame"
 * were readFileSync + regex assertions, so a moved call or an emitted-but-
 * ineffective frame would stay green. The store is importable in node with a
 * small window shim, so the whole path can be exercised for real: a fake
 * backend whose connectEvents emits a health.snapshot frame drives the
 * store's own onFrame dispatch, and init()'s boot batch is asserted through
 * the backend seam rather than by grepping source. */
async function loadStore() {
  (globalThis as any).window = globalThis;
  (globalThis as any).requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  return await import("../src/lib/store");
}

function fakeBackend(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  let emit: ((f: unknown) => void) | undefined;
  const backend: any = {
    mode: "live",
    health: async () => {
      calls.push("health");
      return { commit: "x", version: "0.1.0", bind: "b", dataDir: "d", state: "ok", time: 1, subsystems: [{ name: "store", state: "ok" }] };
    },
    connectEvents: (onFrame: (f: unknown) => void) => {
      emit = onFrame;
      return () => undefined;
    },
    ...Object.fromEntries(
      ["harnesses", "agents", "listSessions", "listTerminals", "todos", "feed", "hosts", "trash"]
        .map((m) => [m, async () => { calls.push(m); return m === "harnesses" ? { harnesses: [], models: [] } : {}; }]),
    ),
    ...overrides,
  };
  return { backend, calls, emitFrame: (f: unknown) => emit?.(f) };
}

test("init() fetches health through the backend seam, and a frame drives the dot", async () => {
  const { store } = await loadStore();
  const { backend, calls, emitFrame } = fakeBackend();

  await store.init(backend);
  assert.ok(calls.includes("health"), "init() must ask the backend for the readiness report");

  /* the frame path, exercised for real: emit through connectEvents and let
     the store's own onFrame dispatch it */
  emitFrame({
    seq: 999,
    ev: {
      type: "health.snapshot",
      sessionId: "",
      health: {
        commit: "abc1234", version: "0.1.0", bind: "0.0.0.0:4040", dataDir: "/tmp", state: "degraded", time: 2,
        subsystems: [
          { name: "store", state: "ok", detail: "sqlite open" },
          { name: "adapter:hermes", state: "degraded", detail: "not found on PATH: hermes-acp" },
        ],
      },
    },
  });
  assert.equal(store.state.health?.state, "degraded", "the emitted frame reached app state");
  assert.equal(healthDotState(store.state.health), "degraded", "and the dot reflects it");
  assert.deepEqual(
    healthRows(store.state.health).map((r) => r.name).sort(),
    ["adapter:hermes", "store"],
    "and the popover rows match the frame",
  );
});
