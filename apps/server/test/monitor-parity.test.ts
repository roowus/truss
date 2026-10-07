import { test } from "node:test";
import assert from "node:assert/strict";

/* SPEC-TESTS for monitor comprehensiveness — https://github.com/roowus/truss/issues/168
   ("Make the truss monitor page as comprehensive as monitor.rewis"). These
   FAIL on purpose today: they pin the contract a fix must satisfy.

   The bar (read from the source — monitor.rewis is the user's own
   rewnet-monitor/2.0, ~/projects/rewnet/monitor/server.py): per-core CPU,
   load 1/5/15, running/blocked/ZOMBIES, ctxt+interrupt+fork rates, full
   meminfo, per-mount disks + PER-DEVICE DISK I/O RATES, per-iface net with
   addresses, socket-state counts, top systemd SERVICES by cpu/mem, LOGS
   (failed units, coredumps, journal tail), logged-in USERS, pending UPDATES,
   host card (os/kernel/arch/cpu model/freq/boot time).

   Truss's HostMetrics (proto/metrics.ts) already carries perCore/load/
   running/blocked/pressure/temps/procs. The gap this pins:

     cpu.zombies, cpu.ctxtPerSec, intrPerSec, forksPerSec
     diskIo: { device, readBps, writeBps }[]
     sock: { tcp, tcpTw, udp, … } (state counts)
     services: { name, cpu, rssMb }[]
     logs: { failedUnits: string[], coredumps: number | null }
     sys: { users: string[], updatesPending: number | null }
     host.freqMhz, host.bootAt

   Everything additive-optional: non-Linux / older agents simply omit. */

/* relative import — the metrics.test.ts precedent (proto has no runner) */
import { collectMetrics } from "../../../packages/proto/src/metrics.js";

test("collectMetrics carries the comprehensiveness sections (this box is Linux)", async () => {
  const m = await collectMetrics();
  assert.ok(m, "a metrics snapshot");

  const cpu = m.cpu as Record<string, unknown>;
  assert.equal(typeof cpu.zombies, "number", "zombie count (rewnet has it; truss must too)");
  assert.equal(typeof cpu.ctxtPerSec, "number", "context-switch rate");
  assert.equal(typeof cpu.intrPerSec, "number", "interrupt rate");
  assert.equal(typeof cpu.forksPerSec, "number", "fork rate");

  assert.ok(Array.isArray((m as any).diskIo), "per-device disk I/O rates");
  const sda = (m as any).diskIo.find((d: any) => /vd|sd|nvme/.test(d.device));
  if (sda) {
    assert.equal(typeof sda.readBps, "number", "read rate");
    assert.equal(typeof sda.writeBps, "number", "write rate");
  }

  const sock = (m as any).sock;
  assert.ok(sock && typeof sock.tcp === "number", "socket-state counts");

  assert.ok(Array.isArray((m as any).services), "top systemd services by cpu/mem");
  const svc = (m as any).services[0];
  if (svc) {
    assert.equal(typeof svc.name, "string");
    assert.equal(typeof svc.cpu, "number");
    assert.equal(typeof svc.rssMb, "number");
  }

  const logs = (m as any).logs;
  assert.ok(logs && Array.isArray(logs.failedUnits), "failed units list");

  const sys = (m as any).sys;
  assert.ok(sys && Array.isArray(sys.users), "logged-in users");

  const host = m.host as Record<string, unknown>;
  assert.equal(typeof host.freqMhz, "number", "cpu frequency");
  assert.equal(typeof host.bootAt, "number", "boot timestamp");
});

test("disk I/O rates: two /proc/diskstats snapshots → correct B/s (pure fixture pin)", async () => {
  const spec = "../../../packages/proto/src/metrics.js"; // variable specifier: same-module extension
  const mod: any = await import(spec);
  assert.equal(typeof mod.diskIoRates, "function", "metrics.ts must export diskIoRates(prev, cur, dtMs) — see issue #168");

  const before = `   8       0 sda 1000 0 40000 5000 2000 0 80000 7000 0 3000 12000`;
  const after = `   8       0 sda 1100 0 42400 5100 2200 0 96000 7100 0 3100 12200`;
  /* sectors are 512 bytes: reads 2400 sectors, writes 16000 sectors over 2s */
  const rates = mod.diskIoRates(before, after, 2000);
  const sda = rates.find((r: { device: string }) => r.device === "sda");
  assert.ok(sda, "the device appears");
  assert.equal(sda.readBps, (2400 * 512) / 2, "read B/s from the sector delta");
  assert.equal(sda.writeBps, (16000 * 512) / 2, "write B/s");

  /* counter reset / zero dt never explodes */
  assert.doesNotThrow(() => mod.diskIoRates(after, before, 2000));
  assert.doesNotThrow(() => mod.diskIoRates(before, after, 0));
});
