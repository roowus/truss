import { test } from "node:test";
import assert from "node:assert/strict";

/* Companion pins for the monitor-parity collectors (issue #168) — the pure
   helpers monitor-parity.test.ts doesn't cover: sockstat + /proc/net/tcp
   parsing, utmp user extraction, and diskIoRates edge cases beyond the
   issue's own fixture pin. */

const metrics: any = await import("../../../packages/proto/src/metrics.js");

const SOCKSTAT_FIXTURE = [
  "sockets: used 373",
  "TCP: inuse 57 orphan 1 tw 3 alloc 66 mem 0",
  "UDP: inuse 5 mem 0",
  "UDPLITE: inuse 0",
  "RAW: inuse 0",
  "FRAG: inuse 0 memory 0",
].join("\n");

const NET_TCP_FIXTURE = [
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
  "   0: 0100007F:13D8 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345",
  "   1: 0100007F:0035 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12346",
  "   2: 8C1656AC:B7CA 93B20636:01BB 01 00000000:00000000 00:00000000 00000000  1000        0 12347",
  "   3: 8C1656AC:13D9 93B20636:01BB 06 00000000:00000000 00:00000000 00000000  1000        0 0",
  "   4: 8C1656AC:13DA 93B20636:01BB 08 00000000:00000000 00:00000000 00000000  1000        0 12349",
  "   5: 8C1656AC:13DB 93B20636:01BB 04 00000000:00000000 00:00000000 00000000  1000        0 12350",
  "",
].join("\n");

test("parseSockstat: inuse totals per family", () => {
  assert.equal(typeof metrics.parseSockstat, "function", "metrics.ts must export parseSockstat — see issue #168");
  const s = metrics.parseSockstat(SOCKSTAT_FIXTURE);
  assert.equal(s.used, 373);
  assert.equal(s.tcp, 57);
  assert.equal(s.udp, 5);
  assert.equal(s.raw, 0);
});

test("parseSockstat: empty/garbage input zeros out, never NaN", () => {
  const s = metrics.parseSockstat("");
  assert.deepEqual(s, { used: 0, tcp: 0, udp: 0, raw: 0 });
  const g = metrics.parseSockstat("TCP: inuse notanumber\n");
  assert.equal(g.tcp, 0, "unparseable counts fall back to 0");
});

test("parseNetTcp: hex states bucketed; header skipped; unknown states count as other", () => {
  assert.equal(typeof metrics.parseNetTcp, "function", "metrics.ts must export parseNetTcp — see issue #168");
  const c = metrics.parseNetTcp(NET_TCP_FIXTURE);
  assert.equal(c.listen, 2, "two 0A rows");
  assert.equal(c.established, 1, "one 01 row");
  assert.equal(c.timeWait, 1, "one 06 row");
  assert.equal(c.closeWait, 1, "one 08 row");
  assert.equal(c.other, 1, "fin_wait1 (04) lands in other");
});

test("parseNetTcp: empty input (no tcp6 file) zeros out", () => {
  assert.deepEqual(metrics.parseNetTcp(""), { established: 0, timeWait: 0, closeWait: 0, listen: 0, other: 0 });
});

/* a synthetic utmp: one USER_PROCESS (type 7) for "ubuntu", one DEAD_PROCESS
   (type 8) for "ghost", one duplicate login — expect ["ubuntu"] only */
function utmpFixture(): Buffer {
  const rec = (type: number, name: string) => {
    const b = Buffer.alloc(384);
    b.writeInt16LE(type, 0);
    b.write(name, 44, "utf8");
    return b;
  };
  return Buffer.concat([rec(7, "ubuntu"), rec(8, "ghost"), rec(7, "ubuntu")]);
}

test("parseUtmpUsers: USER_PROCESS only, deduped, NUL-terminated names", () => {
  assert.equal(typeof metrics.parseUtmpUsers, "function", "metrics.ts must export parseUtmpUsers — see issue #168");
  assert.deepEqual(metrics.parseUtmpUsers(utmpFixture()), ["ubuntu"]);
  assert.deepEqual(metrics.parseUtmpUsers(Buffer.alloc(0)), [], "empty utmp → nobody");
  assert.deepEqual(metrics.parseUtmpUsers(Buffer.alloc(100)), [], "short buffer never crashes");
});

test("diskIoRates: partitions and virtual devices are filtered, whole disks stay", () => {
  const cur = [
    "   7       0 loop0 100 0 200 10 0 0 0 0 0 10 10", // virtual — dropped
    "   8       0 sda 1000 0 40000 5000 2000 0 80000 7000 0 3000 12000", // whole disk — kept
    "   8       1 sda1 900 0 39000 4000 1900 0 79000 6000 0 2900 11000", // partition — dropped
    " 259       0 nvme0n1 500 0 20000 1000 100 0 40000 2000 0 1000 3000", // whole nvme — kept
    " 259       1 nvme0n1p1 400 0 19000 900 90 0 39000 1900 0 900 2900", // p-partition — dropped
  ].join("\n");
  const rates = metrics.diskIoRates(null, cur, 1000);
  assert.deepEqual(
    rates.map((r: { device: string }) => r.device).sort(),
    ["nvme0n1", "sda"],
    "loop + partitions filtered regardless of prev",
  );
  for (const r of rates) {
    assert.equal(r.readBps, 0, "no prev sample → 0 rate, not NaN");
    assert.equal(r.writeBps, 0);
  }
});

test("diskIoRates: numeric-family whole disks survive (md127, nbd15, zd12) — audit round 1 B1", () => {
  /* the first partition-regex arm used to end in md\d+|nbd\d+|zd\d+ followed
     by \d+ — backtracking split md127 into "md12"+"7" and the kernel's
     default auto-assembled RAID name vanished from the panel. Numeric
     families partition pN-style, so whole disks must survive. */
  const cur = [
    "   9     127 md127 100 0 4000 500 200 0 8000 700 0 300 1200", // whole RAID array — kept
    "   9       0 md0 100 0 4000 500 200 0 8000 700 0 300 1200", // whole array — kept
    "   9       1 md0p1 100 0 4000 500 200 0 8000 700 0 300 1200", // partition — dropped
    "  43      15 nbd15 100 0 4000 500 200 0 8000 700 0 300 1200", // whole nbd — kept
    "  43      16 nbd15p1 100 0 4000 500 200 0 8000 700 0 300 1200", // partition — dropped
    " 254      12 zd12 100 0 4000 500 200 0 8000 700 0 300 1200", // whole zd — kept
  ].join("\n");
  assert.deepEqual(
    metrics.diskIoRates(null, cur, 1000).map((r: { device: string }) => r.device).sort(),
    ["md0", "md127", "nbd15", "zd12"],
  );
});

test("diskIoRates: counter reset clamps to 0, never negative", () => {
  const before = `   8       0 sda 1000 0 40000 5000 2000 0 80000 7000 0 3000 12000`;
  const afterReset = `   8       0 sda 10 0 400 50 20 0 800 70 0 30 120`; // device reset (e.g. replug)
  const rates = metrics.diskIoRates(before, afterReset, 2000);
  assert.equal(rates[0].readBps, 0);
  assert.equal(rates[0].writeBps, 0);
});

test("diskIoRates: a device absent from prev reports 0 (hotplug, first sighting)", () => {
  const before = `   8       0 sda 1000 0 40000 5000 2000 0 80000 7000 0 3000 12000`;
  const cur = `${before}\n   8      16 sdb 100 0 4000 500 200 0 8000 700 0 300 1200`;
  const rates = metrics.diskIoRates(before, cur, 2000);
  const sdb = rates.find((r: { device: string }) => r.device === "sdb");
  assert.ok(sdb, "the new device appears");
  assert.equal(sdb.readBps, 0);
  assert.equal(sdb.writeBps, 0);
});

test("collectMetrics live: second sample yields non-negative rates everywhere (real /proc)", async () => {
  await metrics.collectMetrics(); // prime
  await new Promise((r) => setTimeout(r, 150));
  const m = await metrics.collectMetrics();
  assert.ok(m.cpu.ctxtPerSec >= 0 && m.cpu.intrPerSec >= 0 && m.cpu.forksPerSec >= 0);
  assert.ok(m.cpu.zombies >= 0 && Number.isInteger(m.cpu.zombies));
  for (const d of m.diskIo) {
    assert.ok(d.readBps >= 0 && d.writeBps >= 0, `${d.device} rates in range`);
  }
  assert.ok(m.sock.tcp >= 0 && m.sock.used >= m.sock.tcp, "sockstat totals consistent");
  for (const s of m.services) {
    assert.ok(s.cpu >= 0 && s.rssMb >= 0, `${s.name} well-formed`);
    assert.ok(!s.name.endsWith(".service"), "unit suffix is stripped");
  }
});
