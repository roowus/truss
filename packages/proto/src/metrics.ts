import { readdirSync, readFileSync, statfsSync } from "node:fs";
import { hostname as osHostname, arch as osArch } from "node:os";

/**
 * Zero-dependency host vitals from /proc + /sys (Linux). Shared by the Truss
 * server (its own host) and every node-agent (its host) — the Monitor tab's
 * data source. Modeled on the monitor.rewis payload, trimmed to what the
 * panel shows.
 */

export interface HostMetrics {
  at: number;
  host: { hostname: string; os: string; kernel: string; arch: string; cpuModel: string; cores: number };
  uptimeSec: number;
  cpu: { usage: number; perCore: number[]; load: [number, number, number]; procs: number; threads: number; running: number; blocked: number };
  pressure: { cpu: number; io: number; mem: number };
  mem: { total: number; used: number; available: number; cached: number; swapTotal: number; swapUsed: number };
  disks: { device: string; mount: string; fs: string; total: number; used: number; pct: number }[];
  net: { iface: string; rxBps: number; txBps: number }[];
  temps: { label: string; c: number }[];
  procs: { pid: number; cmd: string; cpu: number; rssMb: number; state: string }[];
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

const busyOf = (t: number[]) => t.reduce((a, v, i) => a + (i >= 3 && i <= 4 ? 0 : v), 0) + (t[7] ?? 0) + (t[8] ?? 0); // idle+iowait excluded; steal counts
const allOf = (t: number[]) => t.reduce((a, v) => a + v, 0);

function meminfo(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const ln of read("/proc/meminfo").split("\n")) {
    const m = ln.match(/^(\w+):\s+(\d+)/);
    if (m) out[m[1]] = Number(m[2]) * 1024;
  }
  return out;
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

import { execFileSync } from "node:child_process";

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
      out.push({ device: dev, mount, fs, total, used: total - free, pct: Math.round(((total - free) / total) * 1000) / 10 });
    } catch {
      /* unreadable */
    }
  }
  return out.sort((a, b) => a.mount.localeCompare(b.mount));
}

function netRates(prev: Record<string, [number, number]> | null, dt: number): { list: HostMetrics["net"]; cur: Record<string, [number, number]> } {
  const cur: Record<string, [number, number]> = {};
  for (const ln of read("/proc/net/dev").split("\n").slice(2)) {
    const m = ln.match(/^\s*([\w.-]+):\s*(.*)$/);
    if (!m || m[1] === "lo") continue;
    const f = m[2].trim().split(/\s+/);
    cur[m[1]] = [Number(f[0]), Number(f[8])];
  }
  const list: HostMetrics["net"] = [];
  for (const [iface, [rx, tx]] of Object.entries(cur)) {
    const p = prev?.[iface];
    list.push({ iface, rxBps: p ? Math.max(0, (rx - p[0]) / dt) : 0, txBps: p ? Math.max(0, (tx - p[1]) / dt) : 0 });
  }
  return { list: list.sort((a, b) => b.rxBps + b.txBps - (a.rxBps + a.txBps)), cur };
}

function temps(): HostMetrics["temps"] {
  const out: HostMetrics["temps"] = [];
  try {
    for (const d of readdirSync("/sys/class/thermal")) {
      if (!d.startsWith("thermal_zone")) continue;
      const t = Number(read(`/sys/class/thermal/${d}/temp`)) / 1000;
      const label = read(`/sys/class/thermal/${d}/type`).trim() || d;
      if (t > 0 && t < 150) out.push({ label, c: Math.round(t * 10) / 10 });
    }
  } catch {
    /* no thermal zones */
  }
  return out;
}

interface ProcSnap { pid: number; cmd: string; state: string; rss: number; busy: number }

function procSnap(): { map: Map<number, ProcSnap>; totalBusy: number; totalAll: number } {
  const map = new Map<number, ProcSnap>();
  const { total } = cpuTimes();
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = read(`/proc/${d}/stat`);
      const close = stat.lastIndexOf(")");
      const comm = stat.slice(stat.lastIndexOf("(") + 1, close);
      const f = stat.slice(close + 2).split(" ");
      const status = read(`/proc/${d}/status`);
      const rss = Number(status.match(/VmRSS:\s+(\d+)/)?.[1] ?? 0) * 1024;
      map.set(Number(d), {
        pid: Number(d),
        cmd: comm,
        state: f[0],
        rss,
        busy: Number(f[11]) + Number(f[12]), // utime + stime (clock ticks)
      });
    } catch {
      /* raced exit */
    }
  }
  return { map, totalBusy: busyOf(total), totalAll: allOf(total) };
}

/* rate sampling needs two points — the collector keeps the previous sample
   per process (module state is per-process: server, or each agent) */
let prevCpu: { perCore: number[][]; total: number[] } | null = null;
let prevNet: Record<string, [number, number]> | null = null;
let prevProcs: { map: Map<number, ProcSnap>; totalAll: number } | null = null;
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

  const net = netRates(prevNet, prevNet ? dt : 1);

  const procsNow = procSnap();
  const ticksDelta = Math.max(1, allOf(cpu.total) - (prevProcs?.totalAll ?? allOf(cpu.total)));
  const top: HostMetrics["procs"] = [];
  for (const [pid, p] of procsNow.map) {
    const prev = prevProcs?.map.get(pid);
    const cpuPct = prev ? Math.round(((p.busy - prev.busy) / ticksDelta) * 1000) / 10 : 0;
    top.push({ pid, cmd: p.cmd, cpu: cpuPct, rssMb: Math.round(p.rss / 1048576), state: p.state });
  }
  top.sort((a, b) => b.cpu - a.cpu || b.rssMb - a.rssMb);

  const mem = meminfo();
  const load = read("/proc/loadavg").split(" ").slice(0, 3).map(Number) as [number, number, number];
  const stat = read("/proc/stat");
  const procsTotal = Number(stat.match(/procs_running (\d+)/)?.[1] ?? 0);
  const procsBlocked = Number(stat.match(/procs_blocked (\d+)/)?.[1] ?? 0);
  const threads = Number(stat.match(/processes \d+/) ? read("/proc/loadavg").split(" ")[3]?.split("/")[1] : 0) || 0;

  prevCpu = cpu;
  prevNet = net.cur;
  prevProcs = { map: procsNow.map, totalAll: allOf(cpu.total) };
  prevAt = now;

  return {
    at: now,
    host: {
      hostname: osHostname(),
      os: osName(),
      kernel: read("/proc/sys/kernel/ostype") ? read("/proc/sys/kernel/osrelease").trim() : "",
      arch: osArch(),
      cpuModel: cpuModel(),
      cores: cpu.perCore.length,
    },
    uptimeSec: Number(read("/proc/uptime").split(" ")[0] ?? 0),
    cpu: { usage, perCore, load, procs: procsNow.map.size, threads, running: procsTotal, blocked: procsBlocked },
    pressure: pressure(),
    mem: {
      total: mem.MemTotal ?? 0,
      used: (mem.MemTotal ?? 0) - (mem.MemAvailable ?? 0),
      available: mem.MemAvailable ?? 0,
      cached: (mem.Cached ?? 0) + (mem.Buffers ?? 0),
      swapTotal: mem.SwapTotal ?? 0,
      swapUsed: (mem.SwapTotal ?? 0) - (mem.SwapFree ?? 0),
    },
    disks: disks(),
    net: net.list,
    temps: temps(),
    procs: top.slice(0, 10),
  };
}
