import { test } from "node:test";
import assert from "node:assert/strict";

/* collectMetrics() — zero-dep host vitals from /proc + /sys. The module keeps
   previous-sample state at module level, so rate fields (cpu.usage, perCore,
   net rxBps/txBps, procs cpu) are 0 on the first-ever call and only become
   real rates on a second call a sample window later. These tests run against
   the REAL /proc of the dev/CI machine: assert SHAPE and ranges, never exact
   values. */

// repo-root packages/ is three levels up from apps/server/test/
const { collectMetrics } = await import("../../../packages/proto/src/metrics.js");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("shape: full HostMetrics structure from the real /proc", async () => {
  const m = await collectMetrics();
  assert.equal(typeof m.at, "number");
  assert.ok(m.at > 0);

  // host identity
  assert.ok(m.host.hostname.length > 0);
  assert.ok(m.host.os.length > 0);
  assert.ok(m.host.kernel.length > 0);
  assert.ok(m.host.arch.length > 0);
  assert.ok(m.host.cpuModel.length > 0);
  assert.ok(Number.isInteger(m.host.cores));
  assert.ok(m.host.cores >= 1);

  assert.ok(m.uptimeSec > 0);

  // cpu block
  assert.equal(typeof m.cpu.usage, "number");
  assert.ok(Array.isArray(m.cpu.perCore));
  assert.equal(m.cpu.perCore.length, m.host.cores);
  assert.equal(m.cpu.load.length, 3);
  for (const l of m.cpu.load) {
    assert.equal(typeof l, "number");
    assert.ok(l >= 0);
  }
  assert.ok(m.cpu.procs > 0); // counts numeric /proc entries — never 0 while we run
  assert.ok(m.cpu.threads > 0);
  assert.ok(m.cpu.running >= 0);
  assert.ok(m.cpu.blocked >= 0);

  // pressure stall info (0 when the kernel lacks /proc/pressure/*)
  for (const k of ["cpu", "io", "mem"] as const) {
    assert.equal(typeof m.pressure[k], "number");
    assert.ok(m.pressure[k] >= 0);
  }
});

test("mem: accounting is consistent (used + available == total)", async () => {
  const m = await collectMetrics();
  assert.ok(m.mem.total > 0);
  // used is computed as total - available, so the identity is exact
  assert.equal(m.mem.used + m.mem.available, m.mem.total);
  assert.ok(m.mem.used >= 0);
  assert.ok(m.mem.available > 0);
  assert.ok(m.mem.cached >= 0);
  assert.ok(m.mem.swapTotal >= 0);
  assert.ok(m.mem.swapUsed >= 0);
  assert.ok(m.mem.swapUsed <= m.mem.swapTotal);
});

test('disks: "/" is present, sizes consistent, pct in range, sorted by mount', async () => {
  const m = await collectMetrics();
  assert.ok(m.disks.length >= 1);
  const root = m.disks.find((d) => d.mount === "/");
  assert.ok(root, 'expected a disk mounted at "/"');
  assert.ok(root.total > 0);
  assert.ok(root.used >= 0 && root.used <= root.total);
  assert.ok(root.pct >= 0 && root.pct <= 100);
  for (const d of m.disks) {
    assert.ok(d.device.startsWith("/dev/"));
    assert.ok(d.mount.length > 0);
    assert.ok(d.fs.length > 0);
    assert.ok(d.total > 0);
    assert.ok(d.used <= d.total);
    assert.ok(d.pct >= 0 && d.pct <= 100);
  }
  const mounts = m.disks.map((d) => d.mount);
  assert.deepEqual(mounts, [...mounts].sort((a, b) => a.localeCompare(b)));
});

test("net + temps: arrays with sane entries (lo excluded from net)", async () => {
  const m = await collectMetrics();
  assert.ok(Array.isArray(m.net));
  for (const n of m.net) {
    assert.ok(n.iface.length > 0);
    assert.notEqual(n.iface, "lo");
    assert.ok(n.rxBps >= 0);
    assert.ok(n.txBps >= 0);
  }
  // temps is legitimately EMPTY on hosts without thermal_zone* (e.g. this VM)
  assert.ok(Array.isArray(m.temps));
  for (const t of m.temps) {
    assert.ok(t.label.length > 0);
    assert.ok(t.c > 0 && t.c < 150);
  }
});

test("rates: a second sample ~150ms later yields in-range rates", async () => {
  await collectMetrics(); // prime the module-level previous-sample state
  await sleep(150);
  const m = await collectMetrics();
  assert.ok(m.cpu.usage >= 0 && m.cpu.usage <= 100, `usage ${m.cpu.usage} out of range`);
  assert.equal(m.cpu.perCore.length, m.host.cores);
  for (const c of m.cpu.perCore) {
    assert.ok(c >= 0 && c <= 100, `perCore ${c} out of range`);
  }
  for (const n of m.net) {
    assert.ok(n.rxBps >= 0);
    assert.ok(n.txBps >= 0);
  }
  for (const p of m.procs) {
    assert.ok(p.cpu >= 0);
  }
});

test("procs: top-10, sorted by cpu desc, entries well-formed", async () => {
  const m = await collectMetrics();
  assert.ok(m.procs.length >= 1);
  assert.ok(m.procs.length <= 10);
  for (let i = 1; i < m.procs.length; i++) {
    assert.ok(
      m.procs[i - 1].cpu >= m.procs[i].cpu,
      `procs not sorted by cpu desc at index ${i}: ${m.procs[i - 1].cpu} < ${m.procs[i].cpu}`,
    );
  }
  for (const p of m.procs) {
    assert.ok(Number.isInteger(p.pid) && p.pid > 0);
    assert.ok(p.cmd.length > 0);
    assert.equal(typeof p.cpu, "number");
    assert.ok(p.rssMb >= 0);
    // Linux task states: R S D Z T t W X x K P I (single char)
    assert.match(p.state, /^[RSDZTtWXxKPI]$/);
  }
});
