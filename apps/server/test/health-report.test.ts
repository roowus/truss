import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { bootServer, type TestServer } from "./server-harness.js";
import { buildHealthSnapshot } from "../src/health-snapshot.js";
import { healthRollup, probeAdapters, startupLine, whichSync } from "../src/health.js";

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

  /* the local subsystems that do not depend on a harness binary are all ok.
     (hermes is EXCLUDED on purpose: the test harness fakes HOME, so the
     hermes venv binary genuinely is not there — and reporting it degraded is
     the CORRECT behavior, which the next test pins.) */
  const local = body.subsystems.filter(
    (s: { name: string }) => !s.name.startsWith("adapter:hermes"),
  );
  assert.equal(
    healthRollup(local),
    "ok",
    `expected every non-hermes subsystem ok, got ${JSON.stringify(local.filter((s: { state: string }) => s.state !== "ok"))}`,
  );

  /* hermes is absent in the fake HOME → degraded with a detail, and that
     alone must roll the server up to degraded, never down */
  const hermes = body.subsystems.find((s: { name: string }) => s.name === "adapter:hermes");
  assert.equal(hermes.state, "degraded", "a missing adapter is degraded");
  assert.ok(hermes.detail, "with a detail explaining why");
  assert.notEqual(body.state, "down", "a missing adapter must never report the server as down");
  assert.equal(body.state, healthRollup(body.subsystems), "the reported rollup matches its own rows");
});

/* ── 2. hide a harness binary from PATH → degraded with detail, others ok ── */
test("hiding a harness binary degrades ONLY that adapter, with detail", () => {
  /* a PATH with a fake pi but no dsh. probeAdapters takes the env, so this
     exercises the real probe without touching the running server. */
  const dir = mkdtempSync(join(tmpdir(), "truss-health-path-"));
  const fakePi = join(dir, "pi");
  writeFileSync(fakePi, "#!/bin/sh\nexit 0\n");
  chmodSync(fakePi, 0o755);

  const rows = probeAdapters({ PATH: dir, HOME: dir } as NodeJS.ProcessEnv);
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));

  assert.equal(by["adapter:pi"].state, "ok", "pi is on the fake PATH");
  const dsh = by["adapter:dsh"];
  assert.equal(dsh.state, "degraded", "a missing adapter is DEGRADED, never fatal (issue #219)");
  assert.ok(dsh.detail && dsh.detail.length > 0, "the degraded row must carry a detail saying why");
  assert.match(dsh.detail, /dsh/, "the detail names the binary that is missing");

  /* the other adapters must be unaffected — this is the "others stay ok" half */
  assert.equal(by["adapter:hermes"].state, "degraded", "hermes venv is not in the fake HOME either");

  /* and the rollup of a single missing adapter is degraded, NOT down */
  assert.equal(healthRollup(rows), "degraded", "missing adapters roll up to degraded, never down");

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
