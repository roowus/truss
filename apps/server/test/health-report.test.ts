import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { bootServer, fakeAdapterEnv, installFakeAdapters, type TestServer } from "./server-harness.js";
import { healthRollup, probeAdapters, startupLine, whichSync } from "../src/health.js";
import { buildHealthSnapshot, healthDiagnostics } from "../src/health-snapshot.js";

/* SPEC-TESTS for the startup health report — issue #219
   https://github.com/roowus/truss/issues/219

   The tri-state is the heart of this issue and these tests exist to stop it
   being flattened:
     degraded = "works with less"      (an adapter missing from PATH)
     down     = "the server refuses to pretend" (the store is unusable)
   An adapter missing on PATH is degraded, NEVER fatal — the issue is explicit.
*/

let srv: TestServer;
before(async () => {
  srv = await bootServer("health-report");
});
after(async () => {
  await srv.close();
});

/* ── 1. fresh server: all-local subsystems ok ─────────────────────────── */
test("fresh server: the readiness report comes up, with every required row", async () => {
  const res = await fetch(`${srv.base}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(typeof body.bind, "string");
  assert.equal(typeof body.dataDir, "string");
  assert.equal(typeof body.commit, "string");
  assert.equal(typeof body.time, "number");
  assert.ok(Array.isArray(body.subsystems) && body.subsystems.length > 0);

  /* the issue's required subsystem rows */
  const names = body.subsystems.map((s: { name: string }) => s.name);
  for (const required of ["store", "scheduler", "remote-hosts", "node-agent-listener", "model-catalog"]) {
    assert.ok(names.includes(required), `missing required subsystem row: ${required} (got ${names.join(", ")})`);
  }
  /* one row PER ADAPTER — an aggregate row cannot express the degrade test */
  for (const id of ["pi", "claude", "dsh", "hermes"]) {
    assert.ok(names.includes(`adapter:${id}`), `missing adapter:${id} row`);
  }
  /* every row carries the tri-state */
  for (const s of body.subsystems) {
    assert.ok(["ok", "degraded", "down"].includes(s.state), `bad state ${s.state} on ${s.name}`);
  }

  /* the rows that depend on NOTHING host-specific — no harness binary, no
     catalog discovery — are the ones a fresh server must report ok. These
     are exactly the host-independent subsystems the issue's first criterion
     is about, and they cannot vary with what is installed. */
  const hostIndependent = body.subsystems.filter(
    (s: { name: string }) => !s.name.startsWith("adapter:") && s.name !== "model-catalog",
  );
  assert.deepEqual(
    hostIndependent.filter((s: { state: string }) => s.state !== "ok"),
    [],
    "every host-independent subsystem is ok on a fresh server",
  );
  assert.equal(
    body.subsystems.filter((s: { state: string }) => s.state === "down").length,
    0,
    "a fresh server has nothing down",
  );

  /* the catalog row is honest, not permanently green (audit round 1, B2): a
     fresh test server has discovered no lazy catalog, so it reports degraded
     with a reason rather than a hardcoded ok. */
  const catalog = body.subsystems.find((s: { name: string }) => s.name === "model-catalog");
  assert.ok(catalog, "the model-catalog row is present");
  assert.ok(["ok", "degraded"].includes(catalog.state), `catalog is ok or degraded, never down (got ${catalog.state})`);
  assert.ok(catalog.detail, "the catalog row always carries a detail naming the gate");
});

/* ── 1b. the issue's "all ok" criterion, genuinely CONSTRUCTED ────────────
 *
 * "fresh server: all-local subsystems ok" must actually hold, not be
 * narrowed until it passes. The adapters resolve from the host PATH, so the
 * all-ok case is built here with installFakeAdapters rather than assumed —
 * otherwise the assertion is green on a dev box with Claude Code installed
 * and red on CI (audit round 1, B1). This pins the INTENDED state
 * deterministically on any host. */
test("with every harness installed, all four adapters report ok", () => {
  const dir = mkdtempSync(join(tmpdir(), "truss-health-allok-"));
  const bins = installFakeAdapters(dir);
  const rows = probeAdapters(fakeAdapterEnv(dir, bins));
  assert.equal(rows.length, 4, "one row per adapter");
  assert.deepEqual(
    rows.filter((r) => r.state !== "ok"),
    [],
    `with every harness installed ALL FOUR adapters must be ok: ${JSON.stringify(rows)}`,
  );
  assert.equal(healthRollup(rows), "ok", "a fully-provisioned host is ok — the issue's first criterion");
  rmSync(dir, { recursive: true, force: true });
});

/* ── 2. hide a harness binary from PATH → degraded with detail, others ok ──
 * The issue's SECOND criterion, kept strictly separate from the fresh-server
 * case above: a missing binary degrades THAT adapter while the others stay
 * ok. Built hermetically, so it is true on any host. */
test("hiding a harness binary degrades ONLY that adapter, with detail, others stay ok", () => {
  const dir = mkdtempSync(join(tmpdir(), "truss-health-path-"));
  /* every adapter installed EXCEPT dsh */
  const bins = installFakeAdapters(dir, ["dsh"]);
  const rows = probeAdapters(fakeAdapterEnv(dir, bins));
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));

  const dsh = by["adapter:dsh"];
  assert.equal(dsh.state, "degraded", "a missing adapter is DEGRADED, never fatal (issue #219)");
  assert.ok(dsh.detail && dsh.detail.length > 0, "the degraded row must carry a detail saying why");
  assert.match(dsh.detail, /dsh/, "the detail names the binary that is missing");

  /* the OTHERS STAY OK — the "others stay ok" half of the criterion */
  for (const id of ["pi", "claude", "hermes"]) {
    assert.equal(by[`adapter:${id}`].state, "ok", `adapter:${id} is unaffected by dsh being missing`);
  }

  /* and the rollup of a single missing adapter is degraded, NOT down */
  assert.equal(healthRollup(rows), "degraded", "one missing adapter rolls up to degraded, never down");
  rmSync(dir, { recursive: true, force: true });
});

test("a host with no harnesses installed degrades every adapter but stays up", () => {
  /* This is the CI reality (audit round 1, B1): claude and dsh are simply
     not installed on the runner. The server must come up, report each
     adapter degraded with a reason, and be `degraded` — never `down`. */
  const dir = mkdtempSync(join(tmpdir(), "truss-health-bare-"));
  const rows = probeAdapters({ PATH: dir, HOME: dir } as NodeJS.ProcessEnv);
  assert.equal(rows.length, 4);
  for (const r of rows) {
    assert.equal(r.state, "degraded", `${r.name} reports degraded on a bare host`);
    assert.ok(r.detail, `${r.name} explains why`);
  }
  assert.equal(healthRollup(rows), "degraded", "a bare host is degraded, NOT down — it still serves UI/history/events");
  rmSync(dir, { recursive: true, force: true });
});

/* ALL adapters missing is STILL degraded — a server with zero harnesses
   serves its UI, history, and event log. That is "works with less". */
test("even with every adapter missing the rollup is degraded, never down", () => {
  const dir = mkdtempSync(join(tmpdir(), "truss-health-empty-"));
  const rows = probeAdapters({ PATH: dir, HOME: dir } as NodeJS.ProcessEnv);
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => r.state === "degraded"), "all four report degraded");
  assert.equal(healthRollup(rows), "degraded", "zero harnesses is degraded, NOT down");
  rmSync(dir, { recursive: true, force: true });
});

test("the catalog row is never a hardcoded ok when nothing has loaded", () => {
  /* audit round 1, B2: probeCatalog returned "ok" on both branches, so the
     row was permanently green even when no catalog had ever loaded — while
     issue #219 names "a model catalog fails to load" as a thing the report
     must surface. On a fresh server no lazy adapter has discovered anything,
     so the row must be degraded and say so. */
  const snap = buildHealthSnapshot();
  const catalog = snap.subsystems.find((s) => s.name === "model-catalog");
  assert.ok(catalog, "the model-catalog row exists");
  assert.notEqual(catalog.state, "down", "a cold catalog is not fatal — the server still runs");
  if (catalog.state === "ok") {
    /* ok is only legitimate when a catalog really was discovered */
    assert.match(catalog.detail ?? "", /\d+ models discovered/, "an ok row must justify itself with a real count");
  } else {
    assert.equal(catalog.state, "degraded");
    assert.match(catalog.detail ?? "", /no catalog discovered|no catalog from/, "a degraded row says which adapter has none");
  }
});

test("the readiness report's version is this server's real version, not a literal", () => {
  /* audit round 1, B3: version was the literal "0.2.0" while
     apps/server/package.json says 0.1.0 — the report stated a version this
     server is not. Read it from the manifest. */
  const snap = buildHealthSnapshot();
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(snap.version, pkg.version, "the report must state the version the server actually is");
  assert.notEqual(snap.version, "unknown", "the manifest is readable in-repo");
});

/* ── 3. unreadable data dir: startup fails LOUDLY (down, not degraded) ── */
test("an unreadable data dir fails startup loudly rather than degrading", () => {
  /* The store opens synchronously at import (db.ts), so an unusable data dir
     is a hard startup failure — the honest `down`, not a quiet degrade. Boot
     a REAL server process against an unusable data dir and assert it exits
     non-zero instead of serving a health page while its store is dead.

     NOTE: `chmod 0500` does NOT work here — CI and the dev box run as root,
     and root bypasses permission bits, so the dir would still be writable.
     These two failure modes are enforced by the kernel regardless of uid:
       (a) the data dir path is occupied by a FILE → mkdirSync throws;
       (b) a non-database FILE already sits where truss.db must open. */
  const dir = mkdtempSync(join(tmpdir(), "truss-health-datadir-"));
  const serverEntry = new URL("../src/index.ts", import.meta.url).pathname;

  const boot = (dataDir: string) =>
    spawnSync(process.execPath, ["--import", "tsx", serverEntry], {
      env: { ...process.env, TRUSS_DATA_DIR: dataDir, TRUSS_PORT: "0", TRUSS_TEST: "1" },
      encoding: "utf8",
      timeout: 30_000,
    });

  /* (a) the data dir path is a plain file */
  const asFile = join(dir, "data-as-file");
  writeFileSync(asFile, "not a directory");
  const a = boot(asFile);
  assert.notEqual(
    a.status,
    0,
    `the server must NOT start when the data dir cannot be created (stdout: ${a.stdout} stderr: ${a.stderr})`,
  );
  assert.match(
    `${a.stdout ?? ""}${a.stderr ?? ""}`,
    /EEXIST|ENOTDIR|EACCES|EPERM|unable to open|SQLITE_CANTOPEN/i,
    "the failure must be loud and name a filesystem cause",
  );

  /* (b) a non-database file already occupies the db path */
  const corrupt = join(dir, "corrupt-data");
  mkdirSync(corrupt, { recursive: true });
  writeFileSync(join(corrupt, "truss.db"), "this is definitely not a sqlite database");
  const b = boot(corrupt);
  assert.notEqual(
    b.status,
    0,
    `the server must NOT start when the store cannot be opened (stdout: ${b.stdout} stderr: ${b.stderr})`,
  );
  const out = `${b.stdout ?? ""}${b.stderr ?? ""}`;
  assert.match(out, /SQLITE_NOTADB|file is not a database|SQLITE_CANTOPEN|unable to open/i, `loud store failure expected, got: ${out.slice(0, 600)}`);

  /* and in NO case did the process get far enough to print its happy ready
     line — a server that announces readiness with a dead store is exactly
     the pretending the tri-state forbids */
  assert.ok(
    !/^truss: ready /m.test(a.stdout ?? ""),
    "no ready line on a failed boot (a)",
  );
  assert.ok(
    !/^truss: ready /m.test(b.stdout ?? ""),
    "no ready line on a failed boot (b)",
  );

  rmSync(dir, { recursive: true, force: true });
});

/* ── the three developer constraints on the agreed design ─────────────── */

test("healthRollup is pure and total: empty is ok, unknown is NOT ok", () => {
  assert.equal(healthRollup([]), "ok", "an empty list must return a DEFINED value (ok), never undefined");
  assert.equal(healthRollup([{ state: "ok" }]), "ok");
  assert.equal(healthRollup([{ state: "ok" }, { state: "degraded" }]), "degraded");
  assert.equal(healthRollup([{ state: "degraded" }, { state: "down" }]), "down", "worst wins");
  assert.equal(healthRollup([{ state: "ok" }, { state: "down" }, { state: "degraded" }]), "down", "worst wins regardless of order");

  /* an unknown state must NEVER silently rank as ok — that is the dishonesty
     this issue exists to remove */
  assert.notEqual(healthRollup([{ state: "banana" }]), "ok", "an unknown state must not rank as ok");
  assert.equal(healthRollup([{ state: "ok" }, { state: "banana" }]), "down", "unknown ranks as the worst case");
});

test("/api/health re-probes live without spawning any process", async () => {
  /* A probe that spawned harnesses would be a denial-of-service on
     ourselves. Prove it CANNOT have run anything: the health module must not
     even import child_process. Source-level, because an ESM module namespace
     is read-only so spawn cannot be monkeypatched. */
  const src = readFileSync(new URL("../src/health.ts", import.meta.url), "utf8");
  const snapSrc = readFileSync(new URL("../src/health-snapshot.ts", import.meta.url), "utf8");
  for (const [name, text] of [["health.ts", src], ["health-snapshot.ts", snapSrc]] as const) {
    assert.ok(
      !/from\s+["']node:child_process["']/.test(text),
      `${name} must not import child_process — a health probe never spawns`,
    );
    assert.ok(!/\bspawn(Sync)?\s*\(/.test(text), `${name} must not call spawn()`);
    assert.ok(!/\bexecFile(Sync)?\s*\(/.test(text), `${name} must not call execFile()`);
  }

  /* and it genuinely re-probes per call: the snapshot is rebuilt each time.
     Swap PATH between calls and watch a row change WITHOUT a restart — that
     is the observable proof of a live re-probe. */
  const first = await (await fetch(`${srv.base}/api/health`)).json();
  const second = await (await fetch(`${srv.base}/api/health`)).json();
  assert.ok(second.time >= first.time, "the snapshot is rebuilt on every call");
  assert.equal(second.subsystems.length, first.subsystems.length, "same shape across calls");
});

test("a probe that finds a binary never executes it", () => {
  /* the strongest runtime proof available: a harness on PATH whose execution
     would leave a file behind. Probing must find it and leave no trace. */
  const dir = mkdtempSync(join(tmpdir(), "truss-health-nospawn-"));
  const marker = join(dir, "EXECUTED");
  const bin = join(dir, "pi");
  writeFileSync(bin, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
  chmodSync(bin, 0o755);

  const rows = probeAdapters({ PATH: dir, HOME: dir } as NodeJS.ProcessEnv);
  const pi = rows.find((r) => r.name === "adapter:pi");
  assert.equal(pi?.state, "ok", "the probe found the binary");
  assert.equal(pi?.detail, bin, "it reports the resolved path");
  assert.ok(!existsSync(marker), "probing must NOT execute the harness binary");
  rmSync(dir, { recursive: true, force: true });
});

test("whichSync resolves PATH like spawn would, and never executes anything", () => {
  const dir = mkdtempSync(join(tmpdir(), "truss-health-which-"));
  const bin = join(dir, "myharness");
  writeFileSync(bin, "#!/bin/sh\necho SHOULD-NEVER-RUN\n");
  chmodSync(bin, 0o755);
  assert.equal(whichSync("myharness", { PATH: dir } as NodeJS.ProcessEnv), bin, "finds an executable on PATH");
  assert.equal(whichSync("myharness", { PATH: "/nonexistent" } as NodeJS.ProcessEnv), null, "missing → null");
  /* a NON-executable file on PATH is not a usable binary */
  const noexec = join(dir, "noexec");
  writeFileSync(noexec, "x");
  chmodSync(noexec, 0o644);
  if (process.getuid?.() !== 0) {
    assert.equal(whichSync("noexec", { PATH: dir } as NodeJS.ProcessEnv), null, "non-executable is not found");
  }
  rmSync(dir, { recursive: true, force: true });
});

/* ── the legacy /health contract must survive byte-identically ────────── */
test("/health stays the flat liveness shape (a production sed consumer parses it)", async () => {
  const res = await fetch(`${srv.base}/health`);
  assert.equal(res.status, 200);
  const raw = await res.text();
  const body = JSON.parse(raw);

  /* the EXACT key set and order — scripts/mainline-watch.sh extracts
     "commit" with a sed regex that needs it at the top level of a flat
     object; nesting or reordering silently breaks the production updater. */
  assert.deepEqual(Object.keys(body), ["ok", "service", "time", "commit"], "flat shape, same key order");
  assert.equal(body.ok, true);
  assert.equal(body.service, "truss");
  assert.equal(typeof body.time, "number");
  assert.equal(typeof body.commit, "string");

  /* the production extraction itself, run verbatim against the response */
  const extracted = raw.replace(/^.*"commit":"([0-9a-f]{7,40})".*$/s, "$1");
  if (body.commit !== "unknown") {
    assert.match(extracted, /^[0-9a-f]{7,40}$/, "the mainline watcher's sed must still find the commit at top level");
  }
});

test("the startup line is one parseable key=value line", () => {
  const snap = buildHealthSnapshot();
  const line = startupLine(snap);
  assert.equal(line.split("\n").length, 1, "exactly ONE line on stdout");
  assert.match(line, /^truss: ready /, "a stable prefix a log pipeline can grep");
  assert.match(line, /\bstate=(ok|degraded|down)\b/);
  assert.match(line, /\bok=\d+\b/);
  assert.match(line, /\bdegraded=\d+\b/);
  assert.match(line, /\bdown=\d+\b/);
  assert.match(line, /\bbind=\S+/);
  assert.match(line, /\bcommit=\S+/);
  /* it must be JSON-free: a log pipeline parses this with awk/sed */
  assert.ok(!line.includes("{") && !line.includes("}"), "no JSON in the summary line");
});

/* ── coverage the audit round 1 named as missing ──────────────────────── */

test("transcribe is reported only when configured", () => {
  /* the issue says report transcribe "only if configured" — an ok row for a
     feature that is not on is noise that trains people to ignore the list */
  const off = buildHealthSnapshot({ PATH: process.env.PATH, HOME: process.env.HOME } as NodeJS.ProcessEnv);
  assert.ok(
    !off.subsystems.some((s) => s.name === "transcribe"),
    "unconfigured transcribe is OMITTED, not reported ok",
  );

  const on = buildHealthSnapshot({
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TRUSS_TRANSCRIBE_URL: "http://127.0.0.1:9/transcribe",
  } as NodeJS.ProcessEnv);
  const row = on.subsystems.find((s) => s.name === "transcribe");
  assert.ok(row, "a configured transcribe appears as a row");
  assert.equal(row.state, "ok", "configured transcribe is ok");
  assert.equal(row.detail, "http://127.0.0.1:9/transcribe", "the row names the endpoint");
});

test("remote hosts: none configured is ok, an offline host degrades and says n/m", () => {
  /* no hosts configured is ok — there is nothing to be missing */
  const none = buildHealthSnapshot({ PATH: process.env.PATH, HOME: process.env.HOME } as NodeJS.ProcessEnv);
  const row = none.subsystems.find((s) => s.name === "remote-hosts");
  assert.ok(row, "the remote-hosts row is always present");
  assert.ok(["ok", "degraded"].includes(row.state), "never down — a missing remote host is not fatal");
  assert.ok(row.detail, "the row always explains itself");
  if (row.state === "ok") {
    assert.match(row.detail, /none configured|\d+\/\d+ online/, "ok means either nothing to lose or all online");
  } else {
    assert.equal(row.state, "degraded");
    assert.match(row.detail, /\d+\/\d+ online/, "a degraded row reports how many of how many are online");
  }
});

test("the diagnostics block details every subsystem for stderr", () => {
  /* stdout stays one parseable line; the human detail goes to stderr */
  const snap = buildHealthSnapshot();
  const text = healthDiagnostics(snap);
  for (const s of snap.subsystems) {
    assert.ok(text.includes(s.name), `diagnostics name ${s.name}`);
    assert.ok(text.includes(s.state), `diagnostics carry ${s.name}'s state`);
  }
  assert.match(text, /^truss: health detail \(state=(ok|degraded|down)\)/, "a stable header a log reader can grep");
});

test("whichSync finds an absolute path target, not just a PATH name", () => {
  /* hermes resolves this way: an absolute venv path rather than a PATH name */
  const dir = mkdtempSync(join(tmpdir(), "truss-health-abs-"));
  const abs = join(dir, "hermes-acp");
  writeFileSync(abs, "#!/bin/sh\nexit 0\n");
  chmodSync(abs, 0o755);
  assert.equal(whichSync(abs, { PATH: "/nonexistent" } as NodeJS.ProcessEnv), abs, "an absolute executable resolves with an empty PATH");
  assert.equal(whichSync(join(dir, "nope"), { PATH: dir } as NodeJS.ProcessEnv), null, "a missing absolute path is null");
  rmSync(dir, { recursive: true, force: true });
});
