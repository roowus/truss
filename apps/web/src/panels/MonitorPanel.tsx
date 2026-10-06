import { useEffect, useMemo, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { useApp, useNow } from "@/lib/store";
import { ago } from "@/lib/format";
import { Btn, Empty, Icon, Spinner } from "@/components/ui";
import { Spark } from "./Inspectors";
import { fmtSize, procCell, fmtUptime } from "@/lib/format";
import { gaugeRing } from "@/lib/gaugeGeometry";
import { sparkValueLabel } from "@/lib/sparkline";
import type { HostMetrics, MonitorData } from "@/lib/proto";
import { cn } from "@/utils/cn";

/**
 * Monitor — vitals for every connected device: this server plus each
 * node-agent host (agents answer a metrics request over the tunnel). Same
 * data family as a classic sysstat monitor (cpu/mem/disk/net/temps/top
 * procs/pressure), restyled for Truss, with rolling history sparklines.
 */

const GAUGE_C = (pct: number) => (pct > 90 ? "var(--t-red)" : pct > 70 ? "var(--t-amber)" : "var(--t-teal)");

export function MonitorPanel(_props: IDockviewPanelProps) {
  const be = useApp((s) => s.backend);
  const hosts = useApp((s) => s.hosts);
  const [data, setData] = useState<MonitorData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [device, setDevice] = useState<string>("local");
  const [paused, setPaused] = useState(false);
  const now = useNow(30_000);

  useEffect(() => {
    if (!be || paused) return;
    let off = false;
    const tick = () => {
      be.metrics().then(
        (d) => { if (!off) { setData(d); setErr(null); } },
        (e) => { if (!off) setErr(e.message ?? String(e)); },
      );
    };
    tick();
    const t = window.setInterval(tick, 3000);
    return () => { off = true; window.clearInterval(t); };
  }, [be, paused]);

  /* device chips: this server + registered hosts (online = live metrics) */
  const devices = useMemo(() => {
    const out: { id: string; label: string; online: boolean; live: boolean }[] = [];
    out.push({ id: "local", label: data?.local.metrics.host.hostname ?? "this server", online: true, live: true });
    for (const h of hosts) {
      out.push({ id: h.id, label: h.label, online: h.online, live: !!data?.agents[h.id] });
    }
    return out;
  }, [hosts, data]);

  const entry = device === "local" ? data?.local : data?.agents[device];
  const m = entry?.metrics;
  const hist = entry?.history ?? [];
  const selDevice = devices.find((d) => d.id === device);
  const hostRow = device !== "local" ? hosts.find((h) => h.id === device) : undefined;

  return (
    <div className="h-full flex flex-col bg-[var(--t-bg1)] t-panel">
      <div className="shrink-0 flex items-center gap-1.5 px-3 h-9 border-b border-[var(--t-line)]">
        <Icon name="gauge" size={13} className="text-[var(--t-amber)]" />
        <span className="text-[12px] text-[var(--t-fg)] font-medium">Monitor</span>
        <div className="ml-1 flex items-center gap-1 overflow-x-auto t-scroll-x">
          {devices.map((d) => (
            <button
              key={d.id}
              onClick={() => d.online && setDevice(d.id)}
              disabled={!d.online}
              title={d.online ? `live metrics from ${d.label}` : `${d.label} is offline${hostRow?.lastSeen ? ` (last seen ${ago(hostRow.lastSeen, now)})` : ""}`}
              className={cn(
                "shrink-0 flex items-center gap-1.5 h-6 px-2 rounded-full border text-[11px] font-mono",
                device === d.id ? "border-[var(--t-amber)] text-[var(--t-fg)] bg-[var(--t-amber)]/8" : d.online ? "border-[var(--t-line)] text-[var(--t-mute)] hover:text-[var(--t-fg)]" : "border-[var(--t-line)] text-[var(--t-dim)] opacity-50 cursor-not-allowed",
              )}
            >
              <span className={cn("w-1.5 h-1.5 rounded-full", d.online ? (d.live ? "bg-[var(--t-teal)]" : "bg-[var(--t-amber)]") : "bg-[var(--t-line2)]")} />
              {d.label}
            </button>
          ))}
        </div>
        <span className="ml-auto flex items-center gap-1">
          {m && <span className="font-mono text-[10px] text-[var(--t-dim)] tabular-nums">{paused ? "paused" : "3s"}</span>}
          <Btn size="xs" variant="ghost" icon={paused ? "send" : "stop"} title={paused ? "Resume polling" : "Pause polling"} onClick={() => setPaused((p) => !p)} />
        </span>
      </div>

      <div className="flex-1 min-h-0 overflow-auto t-scroll">
        {err && !data ? (
          <Empty icon="alert" title="Couldn't load metrics">{err}</Empty>
        ) : !m ? (
          <div className="h-full grid place-items-center">
            {selDevice && !selDevice.online ? (
              <Empty icon="host" title={`${selDevice.label} is offline`}>Start its agent and it shows up here live.</Empty>
            ) : (
              <Spinner />
            )}
          </div>
        ) : (
          <MonitorBody m={m} hist={hist} />
        )}
      </div>
    </div>
  );
}

function MonitorBody({ m, hist }: { m: HostMetrics; hist: { t: number; cpu: number; mem: number; rx: number; tx: number }[] }) {
  const cpuPct = m.cpu.usage;
  const memPct = m.mem.total ? (m.mem.used / m.mem.total) * 100 : 0;
  const swapPct = m.mem.swapTotal ? (m.mem.swapUsed / m.mem.swapTotal) * 100 : 0;
  const rootDisk = m.disks.find((d) => d.mount === "/") ?? m.disks[0];
  const times = hist.map((p) => p.t);
  return (
    <div className="p-4 space-y-5">
      {/* host summary */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="font-mono text-[14px] text-[var(--t-fg)]">{m.host.hostname}</div>
        <div className="font-mono text-[10.5px] text-[var(--t-dim)]">{m.host.os} · {m.host.kernel} · {m.host.arch}</div>
        <div className="font-mono text-[10.5px] text-[var(--t-dim)]">{m.host.cpuModel} · {m.host.cores} cores</div>
        <div className="ml-auto font-mono text-[10.5px] text-[var(--t-mute)]">up {fmtUptime(m.uptimeSec)}</div>
      </div>

      {/* gauges */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Gauge label="cpu" pct={cpuPct} detail={`${m.cpu.procs} procs · ${m.cpu.threads} threads`} />
        <Gauge label="memory" pct={memPct} detail={`${fmtSize(m.mem.used)} / ${fmtSize(m.mem.total)}`} />
        <Gauge label="swap" pct={swapPct} detail={m.mem.swapTotal ? `${fmtSize(m.mem.swapUsed)} / ${fmtSize(m.mem.swapTotal)}` : "none"} />
        <Gauge label={`disk ${rootDisk?.mount ?? "/"}`} pct={rootDisk?.pct ?? 0} detail={rootDisk ? `${fmtSize(rootDisk.used)} / ${fmtSize(rootDisk.total)}` : "—"} />
      </div>

      {/* history sparklines — real values with units, never pre-normalized (issue #161) */}
      {hist.length > 1 && (
        <div className="grid sm:grid-cols-3 gap-2">
          <SparkCard label="cpu %" points={hist.map((p) => p.cpu / 100)} unit="%" domain={[0, 1]} times={times} color="var(--t-teal)" />
          <SparkCard label="memory %" points={hist.map((p) => p.mem / 100)} unit="%" domain={[0, 1]} times={times} color="var(--t-violet)" />
          <SparkCard label="net (rx in / tx out)" points={hist.map((p) => p.rx + p.tx)} unit="B/s" times={times} color="var(--t-sky)" />
        </div>
      )}

      {/* per-core + load + pressure */}
      <div className="grid sm:grid-cols-2 gap-2">
        <section className="rounded-lg border border-[var(--t-line)] bg-[var(--t-bg0)]/60 p-3">
          <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--t-dim)] mb-2">per-core</div>
          <div className="flex items-end gap-1 h-14">
            {m.cpu.perCore.map((c, i) => (
              <div key={i} className="flex-1 flex flex-col justify-end h-full" title={`core ${i}: ${c}%`}>
                <div className="rounded-sm" style={{ height: `${Math.max(4, Math.min(100, c))}%`, background: GAUGE_C(c) }} />
              </div>
            ))}
          </div>
          <div className="mt-2 font-mono text-[10px] text-[var(--t-dim)]">load {m.cpu.load.map((l) => l.toFixed(2)).join(" · ")} · {m.cpu.running} running · {m.cpu.blocked} blocked</div>
        </section>
        <section className="rounded-lg border border-[var(--t-line)] bg-[var(--t-bg0)]/60 p-3">
          <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--t-dim)] mb-2">pressure (PSI, 10s avg)</div>
          {([["cpu", m.pressure.cpu], ["io", m.pressure.io], ["memory", m.pressure.mem]] as const).map(([k, v]) => (
            <div key={k} className="flex items-center gap-2 mb-1.5">
              <span className="w-12 font-mono text-[10.5px] text-[var(--t-mute)]">{k}</span>
              <div className="flex-1 h-1.5 rounded-full bg-[var(--t-line)] overflow-hidden">
                <div className="h-full rounded-full" style={{ width: `${Math.min(100, v)}%`, background: GAUGE_C(v) }} />
              </div>
              <span className="w-10 text-right font-mono text-[10px] text-[var(--t-dim)] tabular-nums">{v.toFixed(1)}%</span>
            </div>
          ))}
          {m.temps.length > 0 && (
            <div className="mt-2 flex gap-1.5 flex-wrap">
              {m.temps.map((t) => (
                <span key={t.label} className={cn("font-mono text-[10px] px-1.5 rounded", t.c > 75 ? "bg-[var(--t-red)]/15 text-[var(--t-red)]" : t.c > 60 ? "bg-[var(--t-amber)]/15 text-[var(--t-amber)]" : "bg-[var(--t-bg2)] text-[var(--t-mute)]")} title={t.label}>{t.label} {t.c}°</span>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* disks + net */}
      <div className="grid sm:grid-cols-2 gap-2">
        <section className="rounded-lg border border-[var(--t-line)] bg-[var(--t-bg0)]/60 p-3">
          <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--t-dim)] mb-2">disks</div>
          {m.disks.map((d) => (
            <div key={d.mount} className="flex items-center gap-2 py-0.5" title={`${d.device} · ${d.fs}`}>
              <span className="w-20 truncate font-mono text-[11px] text-[var(--t-fg2)]">{d.mount}</span>
              <div className="flex-1 h-1.5 rounded-full bg-[var(--t-line)] overflow-hidden">
                <div className="h-full" style={{ width: `${d.pct}%`, background: GAUGE_C(d.pct) }} />
              </div>
              <span className="w-24 text-right font-mono text-[10px] text-[var(--t-dim)] tabular-nums">{fmtSize(d.used)} / {fmtSize(d.total)}</span>
              <span className="w-10 text-right font-mono text-[10px] tabular-nums" style={{ color: GAUGE_C(d.pct) }}>{d.pct}%</span>
            </div>
          ))}
        </section>
        <section className="rounded-lg border border-[var(--t-line)] bg-[var(--t-bg0)]/60 p-3">
          <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--t-dim)] mb-2">network</div>
          {m.net.filter((n) => n.rxBps + n.txBps > 0).length === 0 && <div className="text-[11.5px] text-[var(--t-dim)]">interfaces idle</div>}
          {m.net.filter((n) => n.rxBps + n.txBps > 0).map((n) => (
            <div key={n.iface} className="flex items-center gap-2 py-0.5 font-mono text-[11px]">
              <span className="w-24 truncate text-[var(--t-fg2)]">{n.iface}</span>
              <span className="text-[var(--t-teal)]">↓ {fmtSize(n.rxBps)}/s</span>
              <span className="text-[var(--t-sky)]">↑ {fmtSize(n.txBps)}/s</span>
            </div>
          ))}
        </section>
      </div>

      {/* top processes (top-25 like the reference monitor; narrow panes
          shed the least-vital columns first) */}
      <section className="rounded-lg border border-[var(--t-line)] bg-[var(--t-bg0)]/60 overflow-hidden">
        <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--t-dim)] px-3 pt-2.5 pb-1.5">top processes</div>
        <div className="grid grid-cols-[56px_minmax(0,1fr)_56px_56px_64px] sm:grid-cols-[56px_minmax(0,1fr)_64px_56px_56px_64px_40px] md:grid-cols-[56px_minmax(0,1fr)_72px_56px_56px_56px_64px_64px_40px] gap-2 px-3 pb-1 text-[9.5px] font-mono uppercase tracking-wider text-[var(--t-dim)] border-b border-[var(--t-line)]/60">
          <span>pid</span><span>command</span>
          <span className="text-right hidden md:block">user</span>
          <span className="text-right">cpu %</span>
          <span className="text-right hidden sm:block">mem %</span>
          <span className="text-right hidden md:block">thr</span>
          <span className="text-right">rss</span>
          <span className="text-right hidden sm:block">age</span>
          <span className="text-right">st</span>
        </div>
        {m.procs.map((p) => (
          <div key={p.pid} className="grid grid-cols-[56px_minmax(0,1fr)_56px_56px_64px] sm:grid-cols-[56px_minmax(0,1fr)_64px_56px_56px_64px_40px] md:grid-cols-[56px_minmax(0,1fr)_72px_56px_56px_56px_64px_64px_40px] gap-2 px-3 py-1 border-b border-[var(--t-line)]/40 last:border-b-0 font-mono text-[11px]">
            <span className="text-[var(--t-dim)] tabular-nums">{p.pid}</span>
            <span className="truncate text-[var(--t-fg2)]" title={p.cmd}>{p.cmd}</span>
            <span className="text-right text-[var(--t-dim)] truncate hidden md:block">{procCell(p.user)}</span>
            <span className="text-right tabular-nums" style={{ color: GAUGE_C(p.cpu) }}>{p.cpu}</span>
            <span className="text-right text-[var(--t-mute)] tabular-nums hidden sm:block">{procCell(p.memPct)}</span>
            <span className="text-right text-[var(--t-mute)] tabular-nums hidden md:block">{procCell(p.threads)}</span>
            <span className="text-right text-[var(--t-mute)] tabular-nums">{p.rssMb} MB</span>
            <span className="text-right text-[var(--t-dim)] tabular-nums hidden sm:block">{p.ageSec != null ? fmtUptime(p.ageSec) : "—"}</span>
            <span className="text-right text-[var(--t-dim)]">{p.state}</span>
          </div>
        ))}
      </section>
    </div>
  );
}

function Gauge({ label, pct, detail }: { label: string; pct: number; detail: string }) {
  const color = GAUGE_C(pct);
  // Ring geometry comes from gaugeRing so the stroke can never overflow
  // the viewBox (r=30 + strokeWidth 6 in a 64 box used to clip by 1px).
  // One `sw` feeds both the helper and the JSX so a stroke bump
  // recomputes r instead of reintroducing the clip.
  const sw = 6;
  const { r: R, cx, cy } = gaugeRing({ size: 64, strokeWidth: sw });
  const C = 2 * Math.PI * R;
  return (
    <div className="rounded-lg border border-[var(--t-line)] bg-[var(--t-bg0)]/60 p-3 flex items-center gap-3">
      <svg width="64" height="64" viewBox="0 0 64 64" className="shrink-0">
        <circle cx={cx} cy={cy} r={R} fill="none" stroke="var(--t-line)" strokeWidth={sw} />
        <circle cx={cx} cy={cy} r={R} fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeDasharray={`${(Math.min(100, Math.max(0, pct)) / 100) * C} ${C}`} transform={`rotate(-90 ${cx} ${cy})`} />
        <text x={cx} y={cy + 4} textAnchor="middle" fontSize="13" fontFamily="monospace" fill="var(--t-fg)">{Math.round(pct)}%</text>
      </svg>
      <div className="min-w-0">
        <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--t-dim)] truncate">{label}</div>
        <div className="font-mono text-[10.5px] text-[var(--t-mute)] truncate mt-0.5">{detail}</div>
      </div>
    </div>
  );
}

function SparkCard({ label, points, color, unit, domain, times }: {
  label: string; points: number[]; color: string; unit: string; domain?: [number, number]; times?: number[];
}) {
  return (
    <section className="rounded-lg border border-[var(--t-line)] bg-[var(--t-bg0)]/60 p-3">
      <div className="flex items-center font-mono text-[10px] uppercase tracking-wider text-[var(--t-dim)] mb-1.5">
        <span>{label}</span>
        <span className="ml-auto normal-case tabular-nums text-[var(--t-mute)]">{sparkValueLabel(points[points.length - 1] ?? 0, unit)}</span>
      </div>
      <Spark points={points} color={color} unit={unit} domain={domain} times={times} />
    </section>
  );
}
