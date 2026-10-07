import { existsSync, readdirSync, readFileSync, statfsSync, type Dirent } from "node:fs";
import { hostname as osHostname, arch as osArch, networkInterfaces } from "node:os";

/**
 * Zero-dependency host vitals from /proc + /sys (Linux). Shared by the Truss
 * server (its own host) and every node-agent (its host) — the Monitor tab's
 * data source. Modeled on the monitor.rewis payload, trimmed to what the
 * panel shows.
 */

export interface HostMetrics {
  at: number;
  host: {
    hostname: string;
    os: string;
    kernel: string;
    arch: string;
    cpuModel: string;
    cores: number;
    /** mean current clock across cores (0 when the host exposes neither
        cpufreq nor cpuinfo MHz — VMs often have neither) */
    freqMhz?: number;
    /** boot time as ms epoch (from /proc/stat btime) */
    bootAt?: number;
  };
  uptimeSec: number;
  cpu: {
    usage: number;
    perCore: number[];
    load: [number, number, number];
    procs: number;
    threads: number;
    running: number;
    blocked: number;
    zombies?: number;
    /** rates per second from /proc/stat counters (0 on the first sample) */
    ctxtPerSec?: number;
    intrPerSec?: number;
    forksPerSec?: number;
    /** where cpu time went over the sample window, percent (1 dp; user
        includes nice). Absent on the first sample — rates need two points */
    times?: { user: number; system: number; iowait: number; irq: number; softirq: number; steal: number };
  };
  pressure: { cpu: number; io: number; mem: number };
  mem: {
    total: number;
    used: number;
    available: number;
    cached: number;
    swapTotal: number;
    swapUsed: number;
    /* the full /proc/meminfo breakdown (bytes) + /proc/vmstat rates, all
       additive-optional */
    free?: number;
    buffers?: number;
    shared?: number;
    slab?: number;
    dirty?: number;
    writeback?: number;
    committed?: number;
    commitLimit?: number;
    /** hugepage COUNTS (not bytes — 2 MiB pages) */
    hugeTotal?: number;
    hugeFree?: number;
    /** KiB/s moving between ram and block devices (0 on the first sample) */
    pageInKbs?: number;
    pageOutKbs?: number;
    swapInKbs?: number;
    swapOutKbs?: number;
    majFaultsPerSec?: number;
    /** oom kills since boot (counter, not a rate) */
    oomKills?: number;
  };
  disks: { device: string; mount: string; fs: string; total: number; used: number; pct: number; inodePct?: number }[];
  /** whole-disk I/O from /proc/diskstats (partitions and virtual devices
      filtered out); rates are 0 on the first sample. inFlight is a gauge */
  diskIo?: { device: string; readBps: number; writeBps: number; rIops?: number; wIops?: number; inFlight?: number }[];
  net: {
    iface: string;
    rxBps: number;
    txBps: number;
    /** packets/s + lifetime byte totals */
    rxPps?: number;
    txPps?: number;
    rxTotal?: number;
    txTotal?: number;
    /* identity detail: os networkInterfaces + /sys/class/net */
    ip4?: string;
    ip6?: string[];
    mac?: string;
    mtu?: number;
    state?: string;
    speedMbps?: number;
  }[];
  /** socket-state counts: inuse totals from /proc/net/sockstat, per-state
      counts from walking /proc/net/tcp{,6} */
  sock?: {
    tcp: number;
    tcpTw: number;
    established: number;
    listen: number;
    closeWait: number;
    otherTcp: number;
    udp: number;
    raw: number;
    used: number;
  };
  /** top systemd services by cpu then rss, from the cgroup v2 tree */
  services?: { name: string; cpu: number; rssMb: number }[];
  /** refreshed at most once a minute (subprocesses; see logsSlow). Omitted
      entirely when the host lacks systemd, so the panel hides the card
      instead of showing a fake "none" (audit round 1, B2). lines is null
      (not []) when the journal probe alone cannot run — the panel says
      "journal unavailable", never a fake "clean" (audit round 3, B3) */
  logs?: { failedUnits: string[]; coredumps: number | null; lines: string[] | null };
  sys?: {
    users: string[];
    updatesPending: number | null;
    /** dmi vendor + product (the hypervisor/platform); absent when empty */
    virt?: string;
    /** /etc/timezone */
    tz?: string;
    /** bits of kernel entropy available */
    entropy?: number;
    /** open file handles system-wide vs the kernel max (file-nr) */
    filesUsed?: number;
    filesMax?: number;
    /** /var/run/reboot-required exists (a kernel/lib update wants a reboot) */
    rebootRequired?: boolean;
    /** default route from /proc/net/route */
    gateway?: { ip: string; iface: string };
  };
  temps: { label: string; c: number }[];
  /** hwmon fan readings (separate from temps so the °C range invariants hold) */
  fans?: { label: string; rpm: number }[];
  procs: {
    pid: number;
    cmd: string; // full cmdline (args included); kernel threads show [comm]
    cpu: number;
    rssMb: number;
    state: string;
    user: string; // login name (uid resolved via /etc/passwd)
    memPct: number; // 1-dp percent of total memory
    threads: number;
    ageSec: number;
  }[];
}

const read = (p: string) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};

function cpuTimes(): { perCore: number[][]; total: number[] } {
  const lines = read("/proc/stat").split("\n");
  const perCore: number[][] = [];
  let total: number[] = [];
  for (const ln of lines) {
    const m = ln.match(/^cpu(\d*)\s+(.*)$/);
    if (!m) continue;
    const parts = m[2].trim().split(/\s+/).map(Number);
    if (m[1] === "") total = parts;
    else perCore.push(parts);
  }
  return { perCore, total };
}

/* busy = everything except idle(3) and iowait(4). steal(7) and guest(8) are
   already in the sum — guest is folded into user/nice by the kernel — so
   adding them again would double-count and could push usage past 100% */
const busyOf = (t: number[]) => t.reduce((a, v, i) => a + (i >= 3 && i <= 4 ? 0 : v), 0);
const allOf = (t: number[]) => t.reduce((a, v) => a + v, 0);

function meminfo(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const ln of read("/proc/meminfo").split("\n")) {
    const m = ln.match(/^(\w+):\s+(\d+)/);
    /* HugePages_* are COUNTS, everything else is kB (the reference monitor's
       rule — blindly scaling turns 4 hugepages into 4096) */
    if (m) out[m[1]] = m[1].startsWith("HugePages_") ? Number(m[2]) : Number(m[2]) * 1024;
  }
  return out;
}

/** cpu time split over a tick-delta window → 1-dp percents (user folds in
    nice; the panel's segment bar reads exactly this). The denominator stops
    at field 8: the kernel already folds guest(8)/guest_nice(9) into user/
    nice, so summing them in would double-count VM time and deflate every
    share on hosts running guests (audit round 8, B1). */
export function cpuTimeShares(d: number[]): { user: number; system: number; iowait: number; irq: number; softirq: number; steal: number } {
  const tot = d.slice(0, 8).reduce((a, v) => a + v, 0) || 1;
  const p = (...idx: number[]) => Math.round((idx.reduce((a, i) => a + (d[i] ?? 0), 0) / tot) * 1000) / 10;
  return { user: p(0, 1), system: p(2), iowait: p(4), irq: p(5), softirq: p(6), steal: p(7) };
}

/** /proc/vmstat subset — keys kept kernel-side (oom_kill etc.), camelCased
    at the interface. pgpgin/pgpgout are KiB units; pswpin/pswpout are PAGES */
export function parseVmstat(text: string): { pgpgin: number; pgpgout: number; pswpin: number; pswpout: number; pgmajfault: number; oom_kill: number } {
  const out = { pgpgin: 0, pgpgout: 0, pswpin: 0, pswpout: 0, pgmajfault: 0, oom_kill: 0 };
  for (const ln of text.split("\n")) {
    const sp = ln.indexOf(" ");
    if (sp <= 0) continue;
    const k = ln.slice(0, sp) as keyof typeof out;
    const v = Number(ln.slice(sp + 1));
    if (k in out && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/* page size for the pswpin/pswpout → KiB conversion (some arm64 kernels run
   16K/64K pages); getconf once, 4096 fallback */
let _pageKb = 0;
function pageKb(): number {
  if (_pageKb) return _pageKb;
  try {
    _pageKb = Number(execFileSync("getconf", ["PAGESIZE"], { timeout: 2000 }).toString().trim()) / 1024 || 4;
  } catch {
    _pageKb = 4;
  }
  return _pageKb;
}

function pressure(): { cpu: number; io: number; mem: number } {
  const read10 = (p: string) => {
    const m = read(p).match(/some avg10=([\d.]+)/);
    return m ? Number(m[1]) : 0;
  };
  return { cpu: read10("/proc/pressure/cpu"), io: read10("/proc/pressure/io"), mem: read10("/proc/pressure/memory") };
}

function osName(): string {
  const m = read("/etc/os-release").match(/PRETTY_NAME="([^"]+)"/);
  return m?.[1] ?? "Linux";
}

import { execFile, execFileSync } from "node:child_process";

function cpuModel(): string {
  const f = read("/proc/cpuinfo");
  const m = f.match(/model name\s*:\s*(.+)/i) ?? f.match(/^Model\s*:\s*(.+)/mi) ?? f.match(/^Hardware\s*:\s*(.+)/mi);
  if (m?.[1]?.trim()) return m[1].trim();
  /* ARM cpuinfo has no model name — lscpu knows the part numbers */
  try {
    const ls = execFileSync("lscpu", [], { timeout: 3000 }).toString();
    const lm = ls.match(/Model name:\s*(.+)/);
    if (lm) return lm[1].trim();
  } catch {
    /* no lscpu */
  }
  return "unknown";
}

function disks(): HostMetrics["disks"] {
  const out: HostMetrics["disks"] = [];
  const seen = new Set<string>();
  for (const ln of read("/proc/mounts").split("\n")) {
    const [dev, mount, fs] = ln.split(" ");
    if (!dev || !mount) continue;
    if (!dev.startsWith("/dev/") || seen.has(mount)) continue;
    if (/^(squashfs|tmpfs|devtmpfs|overlay|proc|sysfs|cgroup2?|tracefs|debugfs|ramfs|fuse\.)/.test(fs)) continue;
    try {
      const st = statfsSync(mount);
      const total = st.blocks * st.bsize;
      const free = st.bavail * st.bsize;
      if (total <= 0) continue;
      seen.add(mount);
      /* inode fill — a full inode table blocks new files even with space left */
      const inodePct = st.files ? Math.round(((st.files - st.ffree) / st.files) * 1000) / 10 : 0;
      out.push({ device: dev, mount, fs, total, used: total - free, pct: Math.round(((total - free) / total) * 1000) / 10, inodePct });
    } catch {
      /* unreadable */
    }
  }
  return out.sort((a, b) => a.mount.localeCompare(b.mount));
}

/** /proc/net/route → the default route (dest 00000000), gateway hex is
    little-endian. Pure; null when there is no default route */
export function parseNetRoute(text: string): { ip: string; iface: string } | null {
  for (const ln of text.split("\n").slice(1)) {
    const f = ln.trim().split(/\s+/);
    if (f.length > 2 && f[1] === "00000000" && /^[0-9A-Fa-f]{8}$/.test(f[2])) {
      const b = Buffer.from(f[2], "hex");
      return { ip: `${b[3]}.${b[2]}.${b[1]}.${b[0]}`, iface: f[0] };
    }
  }
  return null;
}

/* per-iface identity detail: addresses + mac from os.networkInterfaces,
   mtu/state/speed from /sys/class/net (cheap sysfs reads, no subprocess) */
function ifDetail(): Record<string, { ip4?: string; ip6: string[]; mac?: string; mtu?: number; state?: string; speedMbps?: number }> {
  const out: Record<string, { ip4?: string; ip6: string[]; mac?: string; mtu?: number; state?: string; speedMbps?: number }> = {};
  let osIf: ReturnType<typeof networkInterfaces> = {};
  try {
    osIf = networkInterfaces();
  } catch {
    /* restricted sandbox */
  }
  let names: string[] = [];
  try {
    names = readdirSync("/sys/class/net");
  } catch {
    /* no sysfs */
  }
  for (const name of new Set([...names, ...Object.keys(osIf)])) {
    if (name === "lo") continue;
    const addrs = osIf[name] ?? [];
    const ip4 = addrs.find((a) => a.family === "IPv4" && !a.internal)?.address;
    const ip6 = addrs.filter((a) => a.family === "IPv6" && !a.internal && !a.address.startsWith("fe80")).map((a) => (a.cidr ? a.cidr : a.address));
    const mac = addrs.find((a) => a.mac && a.mac !== "00:00:00:00:00:00")?.mac;
    const mtu = Number(read(`/sys/class/net/${name}/mtu`).trim()) || undefined;
    const state = read(`/sys/class/net/${name}/operstate`).trim() || undefined;
    const sp = Number(read(`/sys/class/net/${name}/speed`).trim());
    out[name] = { ip4, ip6, mac, mtu, state, speedMbps: sp > 0 ? sp : undefined };
  }
  return out;
}

/* tuple per iface: [rxBytes, txBytes, rxPackets, txPackets] */
type NetSnap = Record<string, [number, number, number, number]>;

function netRates(prev: NetSnap | null, dt: number): { list: HostMetrics["net"]; cur: NetSnap } {
  const cur: NetSnap = {};
  for (const ln of read("/proc/net/dev").split("\n").slice(2)) {
    const m = ln.match(/^\s*([\w.-]+):\s*(.*)$/);
    if (!m || m[1] === "lo") continue;
    const f = m[2].trim().split(/\s+/);
    cur[m[1]] = [Number(f[0]), Number(f[8]), Number(f[1]), Number(f[9])];
  }
  const detail = ifDetail();
  const list: HostMetrics["net"] = [];
  for (const [iface, [rx, tx, rxp, txp]] of Object.entries(cur)) {
    const p = prev?.[iface];
    const rate = (c: number, o: number | undefined) => (o === undefined ? 0 : Math.max(0, Math.round((c - o) / dt)));
    const d = detail[iface];
    list.push({
      iface,
      rxBps: rate(rx, p?.[0]),
      txBps: rate(tx, p?.[1]),
      rxPps: rate(rxp, p?.[2]),
      txPps: rate(txp, p?.[3]),
      rxTotal: rx,
      txTotal: tx,
      ...(d?.ip4 ? { ip4: d.ip4 } : {}),
      ...(d?.ip6?.length ? { ip6: d.ip6 } : {}),
      ...(d?.mac ? { mac: d.mac } : {}),
      ...(d?.mtu ? { mtu: d.mtu } : {}),
      ...(d?.state ? { state: d.state } : {}),
      ...(d?.speedMbps ? { speedMbps: d.speedMbps } : {}),
    });
  }
  return { list: list.sort((a, b) => b.rxBps + b.txBps - (a.rxBps + a.txBps)), cur };
}

/* thermal zones + hwmon temp sensors, deduped by label (they often double
   up — acpitz IS a hwmon chip), capped like the reference monitor. The 0-150
   °C guard is load-bearing: apps/server/test/metrics.test.ts pins it. */
function temps(): HostMetrics["temps"] {
  const out: HostMetrics["temps"] = [];
  const seen = new Set<string>();
  const push = (label: string, c: number) => {
    const r = Math.round(c * 10) / 10;
    if (r > 0 && r < 150 && !seen.has(label)) {
      seen.add(label);
      out.push({ label, c: r });
    }
  };
  try {
    for (const d of readdirSync("/sys/class/thermal")) {
      if (!d.startsWith("thermal_zone")) continue;
      push(read(`/sys/class/thermal/${d}/type`).trim() || d, Number(read(`/sys/class/thermal/${d}/temp`)) / 1000);
    }
  } catch {
    /* no thermal zones */
  }
  try {
    for (const hw of readdirSync("/sys/class/hwmon")) {
      const dir = `/sys/class/hwmon/${hw}`;
      const chip = read(`${dir}/name`).trim() || hw;
      for (const e of readdirSync(dir)) {
        if (!/^temp\d+_input$/.test(e)) continue;
        const lbl = read(`${dir}/${e.replace("_input", "_label")}`).trim();
        push(lbl ? `${chip} ${lbl}` : chip, Number(read(`${dir}/${e}`)) / 1000);
      }
    }
  } catch {
    /* no hwmon */
  }
  return out.slice(0, 12);
}

/* hwmon fans — kept off the temps list: rpm would break its 0-150 °C range
   pin (and "4000°" is not a temperature) */
function fans(): NonNullable<HostMetrics["fans"]> | undefined {
  const out: { label: string; rpm: number }[] = [];
  try {
    for (const hw of readdirSync("/sys/class/hwmon")) {
      const dir = `/sys/class/hwmon/${hw}`;
      const chip = read(`${dir}/name`).trim() || hw;
      for (const e of readdirSync(dir)) {
        if (!/^fan\d+_input$/.test(e)) continue;
        const rpm = Number(read(`${dir}/${e}`));
        const lbl = read(`${dir}/${e.replace("_input", "_label")}`).trim();
        if (rpm > 0 && rpm < 100000) out.push({ label: lbl ? `${chip} ${lbl}` : `${chip} ${e.replace("_input", "")}`, rpm: Math.round(rpm) });
      }
    }
  } catch {
    /* no hwmon */
  }
  return out.length ? out.slice(0, 12) : undefined;
}

/** mean scaling_cur_freq across cores (kHz → MHz); VMs without cpufreq fall
    back to /proc/cpuinfo "cpu MHz", then 0 (unknown) */
function cpuFreqMhz(): number {
  const vals: number[] = [];
  try {
    for (const c of readdirSync("/sys/devices/system/cpu")) {
      if (!/^cpu\d+$/.test(c)) continue;
      const v = Number(read(`/sys/devices/system/cpu/${c}/cpufreq/scaling_cur_freq`).trim());
      if (v > 0) vals.push(v / 1000);
    }
  } catch {
    /* no cpufreq */
  }
  if (vals.length) return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
  const mhzs = [...read("/proc/cpuinfo").matchAll(/cpu MHz\s*:\s*([\d.]+)/g)].map((m) => Number(m[1])).filter((v) => v > 0);
  return mhzs.length ? Math.round(mhzs.reduce((a, b) => a + b, 0) / mhzs.length) : 0;
}

/* partition suffixes by name — the pure diskIoRates can't stat /sys, so
   sda1 / nvme0n1p2 / mmcblk0p1 are recognized by shape (whole disks only).
   Only the letter families take bare-digit partitions (sda1); the numeric
   families partition pN-style (md0p1, nbd0p1 — the \d+p\d+$ arm), so md127/
   nbd15/zd12 must stay whole disks (audit round 1, B1) */
const isDiskPart = (n: string) => /^(?:sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+)\d+$/.test(n) || /\d+p\d+$/.test(n);
const SKIP_DISK = /^(loop|ram|sr|dm-)/;

/** two /proc/diskstats snapshots → per-device B/s + iops rates (inFlight is
    a gauge from the cur snapshot). Pure: no fs, no module state. Counter
    resets and zero dt yield 0, never negatives/NaN. */
export function diskIoRates(prev: string | null, cur: string, dtMs: number): { device: string; readBps: number; writeBps: number; rIops: number; wIops: number; inFlight: number }[] {
  const parse = (text: string | null): Map<string, { rSec: number; wSec: number; rIo: number; wIo: number; inFlight: number }> => {
    const m = new Map<string, { rSec: number; wSec: number; rIo: number; wIo: number; inFlight: number }>();
    if (!text) return m;
    for (const ln of text.split("\n")) {
      const f = ln.trim().split(/\s+/);
      /* fields per proc(5): 3=name, 4+8=reads/writes completed, 6+10=sectors
         read/written, 12=ios currently in flight */
      if (f.length < 12) continue;
      const name = f[2];
      if (!name || SKIP_DISK.test(name) || isDiskPart(name)) continue;
      const row = { rSec: Number(f[5]), wSec: Number(f[9]), rIo: Number(f[3]), wIo: Number(f[7]), inFlight: Number(f[11]) };
      if (!Number.isFinite(row.rSec) || !Number.isFinite(row.wSec)) continue;
      m.set(name, row);
    }
    return m;
  };
  const before = parse(prev);
  const after = parse(cur);
  const dtSec = dtMs / 1000;
  const out: { device: string; readBps: number; writeBps: number; rIops: number; wIops: number; inFlight: number }[] = [];
  for (const [device, c] of after) {
    const p = before.get(device);
    let readBps = 0;
    let writeBps = 0;
    let rIops = 0;
    let wIops = 0;
    if (p && dtSec > 0) {
      readBps = Math.max(0, ((c.rSec - p.rSec) * 512) / dtSec);
      writeBps = Math.max(0, ((c.wSec - p.wSec) * 512) / dtSec);
      rIops = Math.max(0, (c.rIo - p.rIo) / dtSec);
      wIops = Math.max(0, (c.wIo - p.wIo) / dtSec);
    }
    out.push({ device, readBps: Math.round(readBps), writeBps: Math.round(writeBps), rIops: Math.round(rIops), wIops: Math.round(wIops), inFlight: c.inFlight });
  }
  return out.sort((a, b) => b.readBps + b.writeBps - (a.readBps + a.writeBps));
}

/** /proc/net/sockstat{,6} → inuse totals. The v6 lines (TCP6/UDP6/RAW6)
    fold into the same buckets — the state walk counts both families too, so
    v4-only inuse would contradict them on a v6-heavy host (audit round 3,
    B1). "sockets: used" exists only in the v4 file, so concatenating both
    files never double-counts it. */
export function parseSockstat(text: string): { used: number; tcp: number; udp: number; raw: number } {
  const out = { used: 0, tcp: 0, udp: 0, raw: 0 };
  for (const ln of text.split("\n")) {
    const f = ln.replace(":", "").split(/\s+/);
    if (f[0] === "sockets" && f[1] === "used") out.used = Number(f[2]) || 0;
    else if ((f[0] === "TCP" || f[0] === "TCP6") && f[1] === "inuse") out.tcp += Number(f[2]) || 0;
    else if ((f[0] === "UDP" || f[0] === "UDP6") && f[1] === "inuse") out.udp += Number(f[2]) || 0;
    else if ((f[0] === "RAW" || f[0] === "RAW6") && f[1] === "inuse") out.raw += Number(f[2]) || 0;
  }
  return out;
}

/* /proc/net/tcp{,6} state hex → bucket (tcp(7)): 01 established, 06
   time_wait, 08 close_wait, 0A listen; everything else lands in other */
const TCP_STATES: Record<string, "established" | "timeWait" | "closeWait" | "listen"> = {
  "01": "established",
  "06": "timeWait",
  "08": "closeWait",
  "0A": "listen",
};

/** one /proc/net/tcp-family file → per-state connection counts */
export function parseNetTcp(text: string): { established: number; timeWait: number; closeWait: number; listen: number; other: number } {
  const out = { established: 0, timeWait: 0, closeWait: 0, listen: 0, other: 0 };
  for (const ln of text.split("\n").slice(1)) {
    const f = ln.trim().split(/\s+/);
    if (f.length < 4) continue;
    const st = f[3].toUpperCase();
    const bucket = TCP_STATES[st];
    if (bucket) out[bucket]++;
    else if (/^[0-9A-F]{2}$/.test(st)) out.other++;
  }
  return out;
}

function sockCounts(): NonNullable<HostMetrics["sock"]> {
  const v4 = parseNetTcp(read("/proc/net/tcp"));
  const v6 = parseNetTcp(read("/proc/net/tcp6"));
  const ss = parseSockstat(`${read("/proc/net/sockstat")}\n${read("/proc/net/sockstat6")}`);
  return {
    tcp: ss.tcp,
    tcpTw: v4.timeWait + v6.timeWait,
    established: v4.established + v6.established,
    listen: v4.listen + v6.listen,
    closeWait: v4.closeWait + v6.closeWait,
    otherTcp: v4.other + v6.other,
    udp: ss.udp,
    raw: ss.raw,
    used: ss.used,
  };
}

/* cgroup v2 service walk: memory.current + cpu.stat usage_usec per .service
   dir; cpu% needs a previous sample per unit (module state is per-process).
    Depth cap matches the reference monitor's (whole tree is sysfs, so cheap) */
const SVC_LIMIT = 12;
let prevSvc = new Map<string, { usec: number; at: number }>();

function services(nowMs: number, cores: number): NonNullable<HostMetrics["services"]> {
  const out: NonNullable<HostMetrics["services"]> = [];
  const seen = new Set<string>();
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    let ents: Dirent[];
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      if (!e.name.endsWith(".service")) {
        walk(`${dir}/${e.name}`, depth + 1);
        continue;
      }
      const name = e.name.slice(0, -".service".length);
      if (seen.has(name)) continue;
      const p = `${dir}/${e.name}`;
      const memRaw = read(`${p}/memory.current`).trim();
      const mem = memRaw === "" || memRaw === "max" ? NaN : Number(memRaw);
      let usec = NaN;
      for (const ln of read(`${p}/cpu.stat`).split("\n")) {
        if (ln.startsWith("usage_usec ")) {
          usec = Number(ln.slice("usage_usec ".length));
          break;
        }
      }
      if (Number.isNaN(mem) && Number.isNaN(usec)) continue;
      seen.add(name);
      let cpu = 0;
      if (!Number.isNaN(usec)) {
        const prev = prevSvc.get(name);
        const dt = (nowMs - (prev?.at ?? nowMs)) / 1000;
        if (prev && dt > 0) cpu = Math.max(0, (((usec - prev.usec) / 1e6) * 100) / dt / Math.max(1, cores));
        prevSvc.set(name, { usec, at: nowMs });
      }
      out.push({ name, cpu: Math.round(cpu * 10) / 10, rssMb: Number.isNaN(mem) ? 0 : Math.round(mem / 1048576) });
    }
  };
  walk("/sys/fs/cgroup", 0);
  /* dead units leave the map so it can't grow unbounded across unit churn */
  for (const k of prevSvc.keys()) if (!seen.has(k)) prevSvc.delete(k);
  out.sort((a, b) => b.cpu - a.cpu || b.rssMb - a.rssMb);
  return out.slice(0, SVC_LIMIT);
}

/** /var/run/utmp binary → logged-in user names (USER_PROCESS records,
    deduped). Record layout per utmp(5): 384 bytes, type int16 at 0,
    user char[32] at 44. */
export function parseUtmpUsers(buf: Uint8Array): string[] {
  const users: string[] = [];
  const seen = new Set<string>();
  for (let off = 0; off + 384 <= buf.length; off += 384) {
    if ((buf[off] | (buf[off + 1] << 8)) !== 7) continue;
    const nameBytes = buf.subarray(off + 44, off + 76);
    const nul = nameBytes.indexOf(0);
    const name = Buffer.from(nameBytes.subarray(0, nul === -1 ? undefined : nul)).toString("utf8");
    if (name && !seen.has(name)) {
      seen.add(name);
      users.push(name);
    }
  }
  return users;
}

function sysInfo(): NonNullable<HostMetrics["sys"]> {
  let utmp: Buffer | null = null;
  try {
    utmp = readFileSync("/var/run/utmp");
  } catch {
    /* no utmp */
  }
  let updatesPending: number | null = null;
  for (const tok of read("/var/lib/update-notifier/updates-available").split(/\s+/)) {
    if (/^\d+$/.test(tok)) {
      updatesPending = Number(tok);
      break;
    }
  }
  /* dmi identity — "KVM QEMU Standard PC..." tells you it's a VM and whose */
  const virt = [read("/sys/class/dmi/id/sys_vendor").trim(), read("/sys/class/dmi/id/product_name").trim()].filter(Boolean).join(" ") || undefined;
  const fileNr = read("/proc/sys/fs/file-nr").trim().split(/\s+/);
  const filesUsed = /^\d+$/.test(fileNr[0] ?? "") ? Number(fileNr[0]) : undefined;
  const filesMax = /^\d+$/.test(fileNr[2] ?? "") ? Number(fileNr[2]) : undefined;
  const entropy = Number(read("/proc/sys/kernel/random/entropy_avail").trim());
  const tz = read("/etc/timezone").trim() || undefined;
  const gateway = parseNetRoute(read("/proc/net/route")) ?? undefined;
  return {
    users: utmp ? parseUtmpUsers(utmp) : [],
    updatesPending,
    ...(virt ? { virt } : {}),
    ...(tz ? { tz } : {}),
    ...(entropy > 0 ? { entropy } : {}),
    ...(filesUsed !== undefined ? { filesUsed } : {}),
    ...(filesMax !== undefined ? { filesMax } : {}),
    rebootRequired: existsSync("/var/run/reboot-required"),
    ...(gateway ? { gateway } : {}),
  };
}

/* execFile that never rejects — a probe that cannot run at all (missing
   binary, nonzero exit with no output, timeout) resolves null so the caller
   can tell "no systemd here" apart from "ran fine, nothing to report" (audit
   round 1, B2); a successful run with empty output resolves "". Exported for
   the null-vs-empty contract pins (audit round 2, B2). */
export function execText(cmd: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      const text = stdout?.toString() ?? "";
      resolve(err && !text ? null : text);
    });
  });
}

/* failed units + coredumps + journal tail are subprocess probes (systemctl,
   journalctl) — far too heavy for every 3s poll, so they refresh at most
   once a minute and every snapshot in between reuses the last result. The
   in-flight promise is shared so overlapping polls never double-spawn.
   Returns null when neither probe can run (a systemd-less host) so the
   section is OMITTED, not rendered as an authoritative-looking empty card
   (audit round 1, B2). */
const LOGS_TTL_MS = 60_000;
type Logs = NonNullable<HostMetrics["logs"]>;
let logsCache: { at: number; logs: Logs | null } | null = null;
let logsPending: Promise<Logs | null> | null = null;

/** probe outputs → the logs block. Pure (exported for the contract pins):
    both null → the whole section is omitted; journal null alone → lines:
    null so the panel shows "journal unavailable", not a fake "clean". */
export function combineLogs(failedOut: string | null, journal: string | null, coredumps: number | null): Logs | null {
  if (failedOut === null && journal === null) return null;
  const failedUnits = (failedOut ?? "")
    .split("\n")
    .map((l) => l.trim().split(/\s+/)[0] ?? "")
    .filter((l) => l.includes("."))
    .slice(0, 12);
  const lines =
    journal === null
      ? null
      : journal
          .split("\n")
          .filter((l) => l.trim().length > 0 && !l.startsWith("-- "))
          .slice(-20);
  return { failedUnits, coredumps, lines };
}

async function logsSlow(): Promise<Logs | null> {
  if (logsCache && Date.now() - logsCache.at < LOGS_TTL_MS) return logsCache.logs;
  if (logsPending) return logsPending;
  logsPending = (async (): Promise<Logs | null> => {
    /* probe budgets stay under requestMetrics' 3500ms remote deadline so a
       slow journal drops a line-count, not the whole agent sample (round 2 B1) */
    const [failedOut, journal] = await Promise.all([
      execText("systemctl", ["--failed", "--no-legend", "--plain"], 1500),
      execText("journalctl", ["-b", "-p", "warning..emerg", "--no-pager", "-n", "20", "-o", "short-iso"], 2000),
    ]);
    let coredumps: number | null = null;
    try {
      coredumps = readdirSync("/var/lib/systemd/coredump").length;
    } catch {
      /* no coredump dir / unreadable */
    }
    const logs = combineLogs(failedOut, journal, coredumps);
    logsCache = { at: Date.now(), logs };
    return logs;
  })().finally(() => {
    logsPending = null;
  });
  return logsPending;
}

interface ProcSnap {
  pid: number;
  cmd: string;
  state: string;
  rss: number;
  busy: number;
  user: string;
  threads: number;
  startTicks: number;
}

/* ── pure parsers (unit-tested with fixtures — see test/metrics-procs) ── */

/** /proc/<pid>/stat — comm survives spaces/parens (split at the LAST close
   paren); field numbers per proc(5): state=3, utime=14, stime=15,
   num_threads=20, starttime=22 */
export function parseProcPidStat(line: string): {
  pid: number;
  comm: string;
  state: string;
  utimeTicks: number;
  stimeTicks: number;
  threads: number;
  startTicks: number;
} | null {
  const open = line.indexOf("(");
  const close = line.lastIndexOf(")");
  if (open === -1 || close === -1 || close < open) return null;
  const pid = Number(line.slice(0, open).trim());
  if (!Number.isInteger(pid)) return null;
  const comm = line.slice(open + 1, close);
  const f = line.slice(close + 2).split(" "); // f[0] = field 3 (state)
  return {
    pid,
    comm,
    state: f[0] ?? "?",
    utimeTicks: Number(f[11] ?? 0),
    stimeTicks: Number(f[12] ?? 0),
    threads: Number(f[17] ?? 0),
    startTicks: Number(f[19] ?? 0),
  };
}

/** /proc/<pid>/cmdline is NUL-joined with a trailing NUL; empty for kernel threads */
export function parseProcCmdline(raw: string): string | null {
  const parts = raw.split("\0").filter((x) => x.length > 0);
  return parts.length ? parts.join(" ") : null;
}

/** /etc/passwd text → uid → login */
export function parsePasswd(text: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const ln of text.split("\n")) {
    const parts = ln.split(":");
    if (parts.length < 3) continue;
    /* a malformed uid field must not become uid 0 — Number("") is 0, so
       "svc:x::1000:…" would label every root-owned process "svc" */
    if (/^\d+$/.test(parts[2])) out.set(Number(parts[2]), parts[0]);
  }
  return out;
}

/** process age from its starttime ticks vs host uptime, floored at 0 */
export function procAgeSec(startTicks: number, uptimeSec: number, hz: number): number {
  return Math.max(0, Math.floor(uptimeSec - startTicks / hz));
}

/** rss as a 1-dp percent of total memory; total 0 → 0 (no divide-by-zero) */
export function procMemPct(rssBytes: number, totalBytes: number): number {
  if (totalBytes <= 0) return 0;
  return Math.round((rssBytes / totalBytes) * 1000) / 10;
}

/* clock ticks/sec — getconf CLK_TCK once (basically always 100 on Linux) */
let _hz = 0;
function clockTicks(): number {
  if (_hz) return _hz;
  try {
    _hz = Number(execFileSync("getconf", ["CLK_TCK"], { timeout: 2000 }).toString().trim()) || 100;
  } catch {
    _hz = 100;
  }
  return _hz;
}

/* uid → login, read once per process (the collector module is per-process) */
let _passwd: Map<number, string> | null = null;
function passwdMap(): Map<number, string> {
  if (!_passwd) _passwd = parsePasswd(read("/etc/passwd"));
  return _passwd;
}

/* one sample of every live process. Only the map is wanted here: the CPU
   rates come from the collector's own cpuTimes() sample, so a second
   /proc/stat read inside procSnap would feed nothing. Zombies stay in the
   map (they render as state Z) and are counted on the side. */
function procSnap(): { map: Map<number, ProcSnap>; zombies: number } {
  const map = new Map<number, ProcSnap>();
  let zombies = 0;
  const passwd = passwdMap();
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = parseProcPidStat(read(`/proc/${d}/stat`));
      if (!st) continue;
      if (st.state === "Z") zombies++;
      const status = read(`/proc/${d}/status`);
      const rss = Number(status.match(/VmRSS:\s+(\d+)/)?.[1] ?? 0) * 1024;
      const uid = Number(status.match(/Uid:\s+(\d+)/)?.[1] ?? 0);
      const full = parseProcCmdline(read(`/proc/${d}/cmdline`));
      map.set(st.pid, {
        pid: st.pid,
        cmd: full ?? `[${st.comm}]`, // kernel thread fallback
        state: st.state,
        rss,
        busy: st.utimeTicks + st.stimeTicks,
        user: passwd.get(uid) ?? String(uid),
        threads: st.threads,
        startTicks: st.startTicks,
      });
    } catch {
      /* raced exit */
    }
  }
  return { map, zombies };
}

/* rate sampling needs two points — the collector keeps the previous sample
   per process (module state is per-process: server, or each agent) */
let prevCpu: { perCore: number[][]; total: number[] } | null = null;
let prevNet: NetSnap | null = null;
let prevProcs: { map: Map<number, ProcSnap>; totalAll: number } | null = null;
let prevStatX: { ctxt: number; intr: number; forks: number } | null = null;
let prevDisk: string | null = null;
let prevVm: { at: number; vm: ReturnType<typeof parseVmstat> } | null = null;
let prevAt = 0;

export async function collectMetrics(): Promise<HostMetrics> {
  const now = Date.now();
  const dt = Math.max(0.1, (now - prevAt) / 1000);

  const cpu = cpuTimes();
  const usage = prevCpu ? Math.round(((busyOf(cpu.total) - busyOf(prevCpu.total)) / Math.max(1, allOf(cpu.total) - allOf(prevCpu.total))) * 1000) / 10 : 0;
  const perCore = cpu.perCore.map((t, i) => {
    const p = prevCpu?.perCore[i];
    if (!p) return 0;
    return Math.round(((busyOf(t) - busyOf(p)) / Math.max(1, allOf(t) - allOf(p))) * 1000) / 10;
  });

  /* where the window's cpu time went (user/system/iowait/…) — shares of the
     per-field tick delta; undefined until a second sample exists */
  const times = prevCpu ? cpuTimeShares(cpu.total.map((v, i) => Math.max(0, v - (prevCpu!.total[i] ?? 0)))) : undefined;

  const net = netRates(prevNet, prevNet ? dt : 1);

  const procsNow = procSnap();
  const ticksDelta = Math.max(1, allOf(cpu.total) - (prevProcs?.totalAll ?? allOf(cpu.total)));
  const mem = meminfo(); // read once — the proc loop's memPct and the mem block below share it
  const memTotal = mem.MemTotal ?? 0;
  const uptimeNow = Number(read("/proc/uptime").split(" ")[0] ?? 0);
  const hz = clockTicks();
  const top: HostMetrics["procs"] = [];
  for (const [pid, p] of procsNow.map) {
    const prev = prevProcs?.map.get(pid);
    const cpuPct = prev ? Math.round(((p.busy - prev.busy) / ticksDelta) * 1000) / 10 : 0;
    top.push({
      pid,
      cmd: p.cmd,
      cpu: cpuPct,
      rssMb: Math.round(p.rss / 1048576),
      state: p.state,
      user: p.user,
      memPct: procMemPct(p.rss, memTotal),
      threads: p.threads,
      ageSec: procAgeSec(p.startTicks, uptimeNow, hz),
    });
  }
  top.sort((a, b) => b.cpu - a.cpu || b.rssMb - a.rssMb);

  const load = read("/proc/loadavg").split(" ").slice(0, 3).map(Number) as [number, number, number];
  const stat = read("/proc/stat");
  const procsTotal = Number(stat.match(/procs_running (\d+)/)?.[1] ?? 0);
  const procsBlocked = Number(stat.match(/procs_blocked (\d+)/)?.[1] ?? 0);
  const threads = Number(stat.match(/processes \d+/) ? read("/proc/loadavg").split(" ")[3]?.split("/")[1] : 0) || 0;

  /* cumulative counters from the same /proc/stat read — rates vs the
     previous sample (0 on the first call, clamped against counter resets) */
  const statX = {
    ctxt: Number(stat.match(/^ctxt (\d+)$/m)?.[1] ?? 0),
    intr: Number(stat.match(/^intr (\d+)/m)?.[1] ?? 0),
    forks: Number(stat.match(/^processes (\d+)$/m)?.[1] ?? 0),
    btime: Number(stat.match(/^btime (\d+)$/m)?.[1] ?? 0),
  };
  const rate = (cur: number, prev: number | undefined) => (prev === undefined ? 0 : Math.max(0, Math.round((cur - prev) / dt)));
  const ctxtPerSec = rate(statX.ctxt, prevStatX?.ctxt);
  const intrPerSec = rate(statX.intr, prevStatX?.intr);
  const forksPerSec = rate(statX.forks, prevStatX?.forks);

  const diskText = read("/proc/diskstats");
  const diskIo = diskIoRates(prevDisk, diskText, dt * 1000);

  /* vmstat rates — pgpg* are KiB, pswp* are pages (pageKb converts) */
  const vm = parseVmstat(read("/proc/vmstat"));
  const vmDt = prevVm ? (now - prevVm.at) / 1000 : 0;
  const vmRate = (c: number, p: number | undefined, scale = 1) => (p === undefined || vmDt <= 0 ? 0 : Math.round(Math.max(0, ((c - p) * scale) / vmDt) * 10) / 10);
  const pageInKbs = vmRate(vm.pgpgin, prevVm?.vm.pgpgin);
  const pageOutKbs = vmRate(vm.pgpgout, prevVm?.vm.pgpgout);
  const swapInKbs = vmRate(vm.pswpin, prevVm?.vm.pswpin, pageKb());
  const swapOutKbs = vmRate(vm.pswpout, prevVm?.vm.pswpout, pageKb());
  const majFaultsPerSec = vmRate(vm.pgmajfault, prevVm?.vm.pgmajfault);

  const logsPromise = logsSlow(); // cached a minute — the subprocess probes don't run per poll; null when the host lacks systemd
  const fansList = fans(); // undefined when the host has no hwmon fans

  prevCpu = cpu;
  prevNet = net.cur;
  prevProcs = { map: procsNow.map, totalAll: allOf(cpu.total) };
  prevStatX = { ctxt: statX.ctxt, intr: statX.intr, forks: statX.forks };
  prevDisk = diskText;
  prevVm = { at: now, vm };
  prevAt = now;

  /* awaited after the prev-state updates so a slow probe never stalls the
     next sample's baseline; null → the key is omitted, not null */
  const logs = await logsPromise;

  return {
    at: now,
    host: {
      hostname: osHostname(),
      os: osName(),
      kernel: read("/proc/sys/kernel/ostype") ? read("/proc/sys/kernel/osrelease").trim() : "",
      arch: osArch(),
      cpuModel: cpuModel(),
      cores: cpu.perCore.length,
      freqMhz: cpuFreqMhz(),
      bootAt: statX.btime > 0 ? statX.btime * 1000 : Math.round(now - uptimeNow * 1000),
    },
    uptimeSec: uptimeNow, // the read the proc loop already did, not a second one
    cpu: { usage, perCore, load, procs: procsNow.map.size, threads, running: procsTotal, blocked: procsBlocked, zombies: procsNow.zombies, ctxtPerSec, intrPerSec, forksPerSec, ...(times ? { times } : {}) },
    pressure: pressure(),
    mem: {
      total: mem.MemTotal ?? 0,
      used: (mem.MemTotal ?? 0) - (mem.MemAvailable ?? 0),
      available: mem.MemAvailable ?? 0,
      cached: (mem.Cached ?? 0) + (mem.Buffers ?? 0),
      swapTotal: mem.SwapTotal ?? 0,
      swapUsed: (mem.SwapTotal ?? 0) - (mem.SwapFree ?? 0),
      free: mem.MemFree ?? 0,
      buffers: mem.Buffers ?? 0,
      shared: mem.Shmem ?? 0,
      slab: mem.Slab ?? 0,
      dirty: mem.Dirty ?? 0,
      writeback: mem.Writeback ?? 0,
      committed: mem.Committed_AS ?? 0,
      commitLimit: mem.CommitLimit ?? 0,
      hugeTotal: mem.HugePages_Total ?? 0,
      hugeFree: mem.HugePages_Free ?? 0,
      pageInKbs: pageInKbs,
      pageOutKbs: pageOutKbs,
      swapInKbs: swapInKbs,
      swapOutKbs: swapOutKbs,
      majFaultsPerSec: majFaultsPerSec,
      oomKills: vm.oom_kill,
    },
    disks: disks(),
    diskIo,
    net: net.list,
    sock: sockCounts(),
    services: services(now, cpu.perCore.length),
    ...(logs ? { logs } : {}),
    sys: sysInfo(),
    temps: temps(),
    ...(fansList ? { fans: fansList } : {}),
    procs: top.slice(0, 25), // the reference monitor's top-25
  };
}
