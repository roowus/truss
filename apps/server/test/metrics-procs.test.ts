import { test } from "node:test";
import assert from "node:assert/strict";

/* SPEC-TESTS for a richer Monitor process table — https://github.com/roowus/truss/issues/10
   ("The monitor table should have more data — reference: monitor.rewis on
   this device"). These pin the contract the issue demanded; the fix landed
   with them, so they pass.

   The reference (fetched from https://monitor.rewis/api/stats on this device)
   shows per process: pid · user · st · cpu% · mem% · rss · thr · age ·
   full cmdline — and "top 25 · all". Truss's collector
   (packages/proto/src/metrics.ts) ships only { pid, cmd(=15-char kernel
   comm), cpu, rssMb, state }, sliced to 10.

   The contract, all exported from packages/proto/src/metrics.ts:

   - collectMetrics() procs entries gain: user (login name), memPct,
     threads, ageSec; cmd becomes the FULL cmdline (args included, kernel
     threads fall back to [comm]); the cap rises to 25 (the sibling
     metrics.test.ts "top-25" pin was amended with this issue).
   - Pure parsers (unit-testable without /proc fixtures of a live box):
     parseProcPidStat(stat-line)   — comm with spaces/parens, state, utime/
                                     stime ticks, num_threads, starttime
     parseProcCmdline(raw)         — NUL-joined cmdline → one string; empty → null
     parsePasswd(text)             — /etc/passwd text → uid → login name
     procAgeSec(startTicks, uptimeSec, hz)   — process age, floored at 0
     procMemPct(rssBytes, totalBytes)        — 1-dp percent; total 0 → 0

   Live-collector tests follow metrics.test.ts convention: real /proc, shape
   and ranges only, never exact values. */

const metrics: any = await import("../../../packages/proto/src/metrics.js");

/* a real /proc/<pid>/stat layout with a hostile comm (parens + spaces):
   pid 1234, comm "weird ) name", state S, ppid 1, …, utime 55, stime 13,
   num_threads 7, starttime 987654 (field numbers noted inline) */
const STAT_FIXTURE =
  "1234 (weird ) name) S 1 1234 1234 0 -1 4194304 100 0 0 0 55 13 0 0 20 0 7 0 987654 123456789 2000 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0";

const PASSWD_FIXTURE = [
  "root:x:0:0:root:/root:/bin/bash",
  "daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin",
  "ubuntu:x:1000:1000:Ubuntu:/home/ubuntu:/bin/bash",
].join("\n");

test("parseProcPidStat: hostile comm survives; state, ticks, threads, starttime extracted", () => {
  assert.equal(typeof metrics.parseProcPidStat, "function", "metrics.ts must export parseProcPidStat — see issue #10");
  const p = metrics.parseProcPidStat(STAT_FIXTURE);
  assert.equal(p.pid, 1234);
  assert.equal(p.comm, "weird ) name", "comm keeps its parens/spaces — split at the LAST close-paren");
  assert.equal(p.state, "S");
  assert.equal(p.utimeTicks, 55, "field 14");
  assert.equal(p.stimeTicks, 13, "field 15");
  assert.equal(p.threads, 7, "field 20 (num_threads) — the table's thr column");
  assert.equal(p.startTicks, 987654, "field 22 (starttime) — the age column's input");
});

test("parseProcCmdline: NUL-joined args become one command line; empty → null (kernel threads)", () => {
  assert.equal(typeof metrics.parseProcCmdline, "function", "metrics.ts must export parseProcCmdline — see issue #10");
  const raw = ["node", "server.js", "--port", "4040"].join("\0") + "\0"; // /proc/<pid>/cmdline layout
  assert.equal(metrics.parseProcCmdline(raw), "node server.js --port 4040");
  assert.equal(metrics.parseProcCmdline(""), null, "kernel threads have an empty cmdline — caller falls back to [comm]");
  assert.equal(metrics.parseProcCmdline("\0\0"), null, "degenerate NULs-only is still empty");
});

test("parsePasswd: uid → login name", () => {
  assert.equal(typeof metrics.parsePasswd, "function", "metrics.ts must export parsePasswd — see issue #10");
  const byUid: Map<number, string> = metrics.parsePasswd(PASSWD_FIXTURE);
  assert.equal(byUid.get(0), "root");
  assert.equal(byUid.get(1000), "ubuntu");
  assert.equal(byUid.get(999999), undefined, "unknown uid → caller falls back to the numeric id");
});

test("procAgeSec: uptime minus start ticks, hz-aware, floored at 0", () => {
  assert.equal(typeof metrics.procAgeSec, "function", "metrics.ts must export procAgeSec — see issue #10");
  assert.equal(metrics.procAgeSec(10_000, 200, 100), 100, "200s uptime, start at 100s → 100s old");
  assert.equal(metrics.procAgeSec(0, 5, 100), 5, "started at boot");
  assert.equal(metrics.procAgeSec(999_999_999, 10, 100), 0, "clock skew never yields a negative age");
});

test("procMemPct: 1-dp percent of total; zero total → 0", () => {
  assert.equal(typeof metrics.procMemPct, "function", "metrics.ts must export procMemPct — see issue #10");
  assert.equal(metrics.procMemPct(256, 1024), 25);
  assert.equal(metrics.procMemPct(1, 3), 33.3, "one decimal place");
  assert.equal(metrics.procMemPct(10, 0), 0, "no divide-by-zero");
});

test("collectMetrics live: every listed proc carries user, memPct, threads, ageSec (real /proc, ranges only)", async () => {
  const m = await metrics.collectMetrics();
  assert.ok(m.procs.length >= 1, "a running box always lists somebody");
  assert.ok(m.procs.length <= 25, "cap rose 10 → 25 (the reference's top-25)");
  for (const p of m.procs) {
    assert.ok(typeof p.user === "string" && p.user.length > 0, `pid ${p.pid}: user column populated (login, not bare uid)`);
    assert.ok(Number.isInteger(p.threads) && p.threads >= 1, `pid ${p.pid}: thr column populated`);
    assert.ok(typeof p.ageSec === "number" && p.ageSec >= 0, `pid ${p.pid}: age column populated`);
    assert.ok(typeof p.memPct === "number" && p.memPct >= 0 && p.memPct <= 100, `pid ${p.pid}: mem% column populated`);
    assert.ok(p.cmd.length > 0, `pid ${p.pid}: command present`);
  }
});
