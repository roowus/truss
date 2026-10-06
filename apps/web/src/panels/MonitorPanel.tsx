import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { store, useApp, useNow } from "@/lib/store";
import { ago } from "@/lib/format";
import { Btn, Empty, Icon, Spinner } from "@/components/ui";
import { Spark } from "./Inspectors";
import { fmtSize, procCell, fmtUptime } from "@/lib/format";
import { gaugeRing } from "@/lib/gaugeGeometry";
import { sparkValueLabel } from "@/lib/sparkline";
import type { HostMetrics, MonitorData } from "@/lib/proto";
import { cn } from "@/utils/cn";

/**
 * Monitor — a full monitor.rewis (rewnet-monitor/2.0) port in Truss clothes:
 * every graph/statistics type the reference dashboard has (gauges, history
 * charts with ranges, per-core bars, cpu time segments, full meminfo +
 * vmstat rates, filesystems + block i/o with iops, per-iface detail, socket
 * states, system card, services, journal, top procs), restyled onto the
 * Truss panel language. Data flows from collectMetrics — this server plus
 * each node-agent host; every newer section is optional and self-hides when
 * an older agent omits it.
 */

const GAUGE_C = (pct: number) => (pct > 90 ? "var(--t-red)" : pct > 70 ? "var(--t-amber)" : "var(--t-teal)");

/* counter rates (ctxt/intr/forks per second) run into the tens of thousands —
   compact them the way load averages never need */
const fmtCnt = (n: number) => (n >= 100_000 ? `${Math.round(n / 1000)}k` : n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

/* cpu time segments (the window's non-idle shares) in truss palette order */
const CPU_SEGS = [
  ["user", "var(--t-teal)"],
  ["system", "var(--t-sky)"],
  ["iowait", "var(--t-amber)"],
  ["irq", "var(--t-violet)"],
  ["softirq", "var(--t-line2)"],
  ["steal", "var(--t-red)"],
] as const;

/* history ranges, same family as the reference's 3m/10m/30m/60m (the server
   ring holds ~60 minutes at the 3s poll) */
const HIST_WINS = [
  ["5m", 300],
  ["15m", 900],
  ["30m", 1800],
  ["60m", 3600],
] as const;

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

  /* the reference monitor's "copy json" — the live snapshot on the
     clipboard, stamped with where and when it came from */
  const copyJson = async () => {
    if (!m) return;
    const payload = { _shared: { from: m.host.hostname, at: new Date().toISOString() }, ...m };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 1));
      store.toast("ok", "Copied", `the live snapshot of ${m.host.hostname} as JSON`);
    } catch {
      store.toast("error", "Copy failed", "clipboard unavailable in this context");
    }
  };

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
          <Btn size="xs" variant="ghost" icon="copy" title="Copy the live snapshot as JSON" disabled={!m} onClick={() => void copyJson()} />
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
  const [histWin, setHistWin] = useState<number>(900);

  /* slice the server history to the selected window (timestamps drive the
     sparkline's hover labels, so slice the pair together) */
  const winHist = useMemo(() => {
    if (hist.length < 2) return hist;
    const cutoff = hist[hist.length - 1].t - histWin * 1000;
    const sliced = hist.filter((p) => p.t >= cutoff);
    return sliced.length >= 2 ? sliced : hist;
  }, [hist, histWin]);
  const winTimes = winHist.map((p) => p.t);

  /* journal prints oldest first — show newest on top. null lines = the
     journal probe cannot run on this host (distinct from "ran, was empty") */
  const logLines = m.logs?.lines ? [...m.logs.lines].reverse() : null;
  const kibs = (v: number | undefined) => `${fmtSize(Math.max(0, Math.round((v ?? 0) * 1024)))}/s`;

  return (
    <div className="p-4 space-y-5">
      {/* host summary */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="font-mono text-[14px] text-[var(--t-fg)]">{m.host.hostname}</div>
        <div className="font-mono text-[10.5px] text-[var(--t-dim)]">{m.host.os} · {m.host.kernel} · {m.host.arch}</div>
        <div className="font-mono text-[10.5px] text-[var(--t-dim)]">
          {m.host.cpuModel} · {m.host.cores} cores
          {m.host.freqMhz ? ` · ${m.host.freqMhz} MHz` : ""}
        </div>
        <div className="ml-auto font-mono text-[10.5px] text-[var(--t-mute)]" title={m.host.bootAt ? `booted ${new Date(m.host.bootAt).toLocaleString()}` : undefined}>
          up {fmtUptime(m.uptimeSec)}
          {m.host.bootAt ? ` · since ${new Date(m.host.bootAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${new Date(m.host.bootAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}` : ""}
        </div>
      </div>

      {/* gauges */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Gauge label="cpu" pct={cpuPct} detail={`${m.cpu.procs} procs · ${m.cpu.threads} threads`} />
        <Gauge label="memory" pct={memPct} detail={`${fmtSize(m.mem.used)} / ${fmtSize(m.mem.total)}`} />
        <Gauge label="swap" pct={swapPct} detail={m.mem.swapTotal ? `${fmtSize(m.mem.swapUsed)} / ${fmtSize(m.mem.swapTotal)}` : "none"} />
        <Gauge label={`disk ${rootDisk?.mount ?? "/"}`} pct={rootDisk?.pct ?? 0} detail={rootDisk ? `${fmtSize(rootDisk.used)} / ${fmtSize(rootDisk.total)}` : "—"} />
      </div>

      {/* history sparklines with the reference's range selector — real values
          with units, never pre-normalized (issue #161); server keeps ~60m */}
      {hist.length > 1 && (
        <div>
          <div className="flex items-center mb-1.5">
            <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--t-dim)]">history</span>
            <span className="ml-auto flex items-center gap-0.5">
              {HIST_WINS.map(([label, sec]) => (
                <button
                  key={sec}
                  onClick={() => setHistWin(sec)}
                  className={cn(
                    "font-mono text-[10px] px-1.5 py-0.5 rounded",
                    histWin === sec ? "text-[var(--t-fg)] bg-[var(--t-bg2)]" : "text-[var(--t-dim)] hover:text-[var(--t-mute)]",
                  )}
                >
                  {label}
                </button>
              ))}
            </span>
          </div>
          <div className="grid sm:grid-cols-3 gap-2">
            <SparkCard label="cpu %" points={winHist.map((p) => p.cpu / 100)} unit="%" domain={[0, 1]} times={winTimes} color="var(--t-teal)" />
            <SparkCard label="memory %" points={winHist.map((p) => p.mem / 100)} unit="%" domain={[0, 1]} times={winTimes} color="var(--t-violet)" />
            <SparkCard label="net (rx in / tx out)" points={winHist.map((p) => p.rx + p.tx)} unit="B/s" times={winTimes} color="var(--t-sky)" />
          </div>
        </div>
      )}

      {/* the detail cards sit 3-up under their history graphs, topic-aligned
          — cpu under the cpu graph, memory under memory, network under
          network; the graph-less cards (pressure, storage, sockets, system,
          services) flow after. Older agents omit blocks and the grid packs. */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
        <section className="rounded-lg border border-[var(--t-line)] bg-[var(--t-bg0)]/60 p-3">
          <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--t-dim)] mb-2">per-core</div>
          <div className="flex items-end gap-1 h-14">
            {m.cpu.perCore.map((c, i) => (
              <div key={i} className="flex-1 flex flex-col justify-end h-full" title={`core ${i}: ${c}%`}>
                <div className="rounded-sm" style={{ height: `${Math.max(4, Math.min(100, c))}%`, background: GAUGE_C(c) }} />
              </div>
            ))}
          </div>
          {m.cpu.times && (
            <div className="mt-2.5" title="where cpu time went over the sample window; the unfilled rest is idle">
              <div className="flex h-1.5 rounded-full overflow-hidden bg-[var(--t-line)]">
                {CPU_SEGS.map(([k, color]) =>
                  m.cpu.times![k] > 0.05 ? <div key={k} style={{ width: `${Math.min(100, m.cpu.times![k])}%`, background: color }} /> : null,
                )}
              </div>
              <div className="mt-1.5 flex gap-2.5 flex-wrap font-mono text-[9.5px] text-[var(--t-dim)]">
                {CPU_SEGS.filter(([k]) => m.cpu.times![k] > 0.05).map(([k, color]) => (
                  <span key={k} className="flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-sm" style={{ background: color }} />
                    {k} {m.cpu.times![k].toFixed(1)}%
                  </span>
                ))}
              </div>
            </div>
          )}
          <div className="mt-2 font-mono text-[10px] text-[var(--t-dim)]">
            load {m.cpu.load.map((l) => l.toFixed(2)).join(" · ")} · {m.cpu.running} running · {m.cpu.blocked} blocked
            {m.cpu.zombies != null && (
              <>
                {" · "}
                <span className={m.cpu.zombies > 0 ? "text-[var(--t-amber)]" : undefined} title="zombie processes (state Z)">
                  {m.cpu.zombies} zombies
                </span>
              </>
            )}
          </div>
          {m.cpu.ctxtPerSec != null && (
            <div className="mt-1 font-mono text-[10px] text-[var(--t-dim)]" title="per-second rates from /proc/stat counters">
              ctxt {fmtCnt(m.cpu.ctxtPerSec)}/s · intr {fmtCnt(m.cpu.intrPerSec ?? 0)}/s · forks {fmtCnt(m.cpu.forksPerSec ?? 0)}/s
            </div>
          )}
        </section>

        {/* memory — the full meminfo + vmstat picture (rows self-hide when an
            older agent omits them) */}
        <section className="rounded-lg border border-[var(--t-line)] bg-[var(--t-bg0)]/60 p-3">
          <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--t-dim)] mb-1.5">memory</div>
          <KV k="used" v={`${fmtSize(m.mem.used)} (${memPct.toFixed(1)}%)`} />
          <KV k="available" v={fmtSize(m.mem.available)} />
          {m.mem.free != null && <KV k="free" v={fmtSize(m.mem.free)} />}
          <KV k="cached" v={fmtSize(m.mem.cached)} />
          {m.mem.buffers != null && <KV k="buffers" v={fmtSize(m.mem.buffers)} />}
          {m.mem.shared != null && <KV k="shared" v={fmtSize(m.mem.shared)} />}
          {(m.mem.slab != null || m.mem.dirty != null || m.mem.writeback != null) && <div className="my-1 border-t border-[var(--t-line)]/60" />}
          {m.mem.slab != null && <KV k="slab" v={fmtSize(m.mem.slab)} />}
          {m.mem.dirty != null && <KV k="dirty" v={fmtSize(m.mem.dirty)} warn={m.mem.dirty > 512 * 1048576} />}
          {m.mem.writeback != null && <KV k="writeback" v={fmtSize(m.mem.writeback)} warn={m.mem.writeback > 0} />}
          {m.mem.committed != null && <KV k="committed / limit" v={`${fmtSize(m.mem.committed)} / ${fmtSize(m.mem.commitLimit ?? 0)}`} warn={!!m.mem.commitLimit && m.mem.committed > m.mem.commitLimit * 0.9} />}
          {(m.mem.hugeTotal ?? 0) > 0 && <KV k="hugepages" v={`${m.mem.hugeFree} free / ${m.mem.hugeTotal}`} />}
          <KV k="swap" v={m.mem.swapTotal ? `${fmtSize(m.mem.swapUsed)} / ${fmtSize(m.mem.swapTotal)}` : "none"} warn={swapPct > 50} />
          {m.mem.pageInKbs != null && <div className="my-1 border-t border-[var(--t-line)]/60" />}
          {m.mem.pageInKbs != null && <KV k="page in / out" v={`${kibs(m.mem.pageInKbs)} · ${kibs(m.mem.pageOutKbs)}`} />}
          {m.mem.swapInKbs != null && <KV k="swap in / out" v={`${kibs(m.mem.swapInKbs)} · ${kibs(m.mem.swapOutKbs)}`} warn={(m.mem.swapInKbs ?? 0) + (m.mem.swapOutKbs ?? 0) > 1024} />}
          {m.mem.majFaultsPerSec != null && <KV k="major faults" v={`${m.mem.majFaultsPerSec}/s`} />}
          {m.mem.oomKills != null && <KV k="oom kills" v={m.mem.oomKills} warn={m.mem.oomKills > 0} />}
        </section>

        <section className="rounded-lg border border-[var(--t-line)] bg-[var(--t-bg0)]/60 p-3">
          <div className="flex items-center font-mono text-[10px] uppercase tracking-wider text-[var(--t-dim)] mb-2">
            <span>network</span>
            {m.sys?.gateway && <span className="ml-auto normal-case text-[var(--t-dim)]">gw {m.sys.gateway.ip} · {m.sys.gateway.iface}</span>}
          </div>
          {m.net.length === 0 && <div className="text-[11.5px] text-[var(--t-dim)]">no interfaces</div>}
          {m.net.map((n) => (
            <div key={n.iface} className="py-1.5 border-b border-[var(--t-line)]/40 last:border-b-0">
              <div className="flex items-center gap-2 font-mono text-[11px]">
                <span className="text-[var(--t-fg2)] font-medium">{n.iface}</span>
                {n.state && (
                  <span className="text-[9.5px] text-[var(--t-dim)]" title={n.speedMbps ? `link ${n.speedMbps} Mbps` : undefined}>
                    <span className={cn("inline-block w-1.5 h-1.5 rounded-full mr-1", n.state === "up" ? "bg-[var(--t-teal)]" : "bg-[var(--t-line2)]")} />
                    {n.state}{n.speedMbps ? ` · ${n.speedMbps}M` : ""}
                  </span>
                )}
                <span className="ml-auto text-[var(--t-teal)] tabular-nums">↓ {fmtSize(n.rxBps)}/s{n.rxPps != null && <span className="text-[var(--t-dim)]"> ({fmtCnt(n.rxPps)} pps)</span>}</span>
                <span className="text-[var(--t-sky)] tabular-nums">↑ {fmtSize(n.txBps)}/s{n.txPps != null && <span className="text-[var(--t-dim)]"> ({fmtCnt(n.txPps)} pps)</span>}</span>
              </div>
              {(n.ip4 || (n.ip6 && n.ip6.length > 0) || n.mac || n.rxTotal != null) && (
                <div className="mt-0.5 font-mono text-[9.5px] leading-snug text-[var(--t-dim)] break-all">
                  {[n.ip4, ...(n.ip6 ?? [])].filter(Boolean).join(" · ") || "no ip"}
                  {n.rxTotal != null && ` · tot ↓${fmtSize(n.rxTotal)} ↑${fmtSize(n.txTotal ?? 0)}`}
                  {n.mtu ? ` · mtu ${n.mtu}` : ""}
                  {n.mac ? ` · ${n.mac}` : ""}
                </div>
              )}
            </div>
          ))}
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
          {(m.temps.length > 0 || (m.fans && m.fans.length > 0)) && (
            <div className="mt-2 flex gap-1.5 flex-wrap">
              {m.temps.map((t) => (
                <span key={t.label} className={cn("font-mono text-[10px] px-1.5 rounded", t.c > 75 ? "bg-[var(--t-red)]/15 text-[var(--t-red)]" : t.c > 60 ? "bg-[var(--t-amber)]/15 text-[var(--t-amber)]" : "bg-[var(--t-bg2)] text-[var(--t-mute)]")} title={t.label}>{t.label} {t.c}°</span>
              ))}
              {(m.fans ?? []).map((f) => (
                <span key={f.label} className="font-mono text-[10px] px-1.5 rounded bg-[var(--t-bg2)] text-[var(--t-mute)]" title={f.label}>{f.label} {fmtCnt(f.rpm)} rpm</span>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-lg border border-[var(--t-line)] bg-[var(--t-bg0)]/60 p-3">
          <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--t-dim)] mb-2">storage</div>
          {m.disks.map((d) => (
            <div key={d.mount} className="flex items-center gap-2 py-0.5" title={`${d.device} · ${d.fs}${d.inodePct != null ? ` · ${d.inodePct}% inodes used` : ""}`}>
              <span className="w-20 truncate font-mono text-[11px] text-[var(--t-fg2)]">{d.mount}</span>
              <div className="flex-1 h-1.5 rounded-full bg-[var(--t-line)] overflow-hidden">
                <div className="h-full" style={{ width: `${d.pct}%`, background: GAUGE_C(d.pct) }} />
              </div>
              <span className="shrink-0 text-right font-mono text-[10px] text-[var(--t-dim)] tabular-nums">
                {fmtSize(d.used)} / {fmtSize(d.total)}
                {d.inodePct != null && <span className={d.inodePct > 90 ? "text-[var(--t-amber)]" : undefined}> · {d.inodePct}% in</span>}
              </span>
              <span className="w-10 shrink-0 text-right font-mono text-[10px] tabular-nums" style={{ color: GAUGE_C(d.pct) }}>{d.pct}%</span>
            </div>
          ))}
          {m.diskIo && m.diskIo.length > 0 && (
            <>
              <div className="mt-2.5 pt-2 border-t border-[var(--t-line)]/60 font-mono text-[10px] uppercase tracking-wider text-[var(--t-dim)]">block i/o</div>
              {m.diskIo.map((d) => (
                <div key={d.device} className="py-0.5 font-mono text-[10.5px]" title={d.inFlight != null ? `${d.inFlight} requests in flight` : undefined}>
                  <span className="text-[var(--t-fg2)]">{d.device}</span>{" "}
                  <span className="text-[var(--t-teal)]">r {fmtSize(d.readBps)}/s{d.rIops != null ? ` (${fmtCnt(d.rIops)} iops)` : ""}</span>{" "}
                  <span className="text-[var(--t-sky)]">w {fmtSize(d.writeBps)}/s{d.wIops != null ? ` (${fmtCnt(d.wIops)} iops)` : ""}</span>
                  {d.inFlight != null && d.inFlight > 0 && <span className="text-[var(--t-dim)]"> · {d.inFlight} in flight</span>}
                </div>
              ))}
            </>
          )}
        </section>

        {m.sock && (
          <section className="rounded-lg border border-[var(--t-line)] bg-[var(--t-bg0)]/60 p-3">
            <div className="flex items-center font-mono text-[10px] uppercase tracking-wider text-[var(--t-dim)] mb-1.5">
              <span>sockets</span>
              <span className="ml-auto normal-case text-[var(--t-dim)]">{m.sock.used} total</span>
            </div>
            <KV k="established" v={m.sock.established} />
            <KV k="time wait" v={m.sock.tcpTw} warn={m.sock.tcpTw > 2000} />
            <KV k="close wait" v={m.sock.closeWait} warn={m.sock.closeWait > 100} />
            <KV k="listening" v={m.sock.listen} />
            <KV k="other tcp" v={m.sock.otherTcp} />
            <div className="my-1 border-t border-[var(--t-line)]/60" />
            <KV k="tcp in use" v={m.sock.tcp} />
            <KV k="udp in use" v={m.sock.udp} />
            <KV k="raw in use" v={m.sock.raw} />
            <KV k="sockets used" v={m.sock.used} />
          </section>
        )}

        {m.sys && (
          <section className="rounded-lg border border-[var(--t-line)] bg-[var(--t-bg0)]/60 p-3">
            <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--t-dim)] mb-1.5">system</div>
            <KV k="hostname" v={m.host.hostname} />
            <KV k="os" v={m.host.os} />
            <KV k="kernel" v={`${m.host.kernel} · ${m.host.arch}`} />
            {m.sys.virt && <KV k="virtualization" v={m.sys.virt} />}
            {m.host.bootAt != null && <KV k="booted" v={new Date(m.host.bootAt).toLocaleString()} />}
            {m.sys.tz && <KV k="timezone" v={m.sys.tz} />}
            <KV k="users" v={m.sys.users.length ? m.sys.users.join(", ") : "none"} />
            {m.sys.entropy != null && <KV k="entropy" v={`${m.sys.entropy} bits`} />}
            {m.sys.filesUsed != null && (
              <KV k="file handles" v={m.sys.filesMax != null && m.sys.filesMax < 1e15 ? `${fmtCnt(m.sys.filesUsed)} / ${fmtCnt(m.sys.filesMax)}` : fmtCnt(m.sys.filesUsed)} />
            )}
            {m.sys.updatesPending != null && <KV k="updates pending" v={m.sys.updatesPending} warn={m.sys.updatesPending > 0} />}
            {m.sys.rebootRequired != null && <KV k="reboot required" v={m.sys.rebootRequired ? "yes" : "no"} warn={m.sys.rebootRequired} />}
            {m.logs && <KV k="failed units" v={m.logs.failedUnits.length} warn={m.logs.failedUnits.length > 0} />}
          </section>
        )}

        {m.services && m.services.length > 0 && (
          <section className="rounded-lg border border-[var(--t-line)] bg-[var(--t-bg0)]/60 p-3">
            <div className="flex items-center font-mono text-[10px] uppercase tracking-wider text-[var(--t-dim)] mb-2">
              <span>services</span>
              <span className="ml-auto normal-case text-[var(--t-dim)]">top by cpu / mem</span>
            </div>
            {m.services.map((s) => (
              <div key={s.name} className="flex items-center gap-2 py-0.5 font-mono text-[11px]">
                <span className="flex-1 min-w-0 truncate text-[var(--t-fg2)]" title={`${s.name}.service`}>{s.name}</span>
                <span className="w-14 text-right tabular-nums" style={{ color: GAUGE_C(s.cpu) }}>{s.cpu}%</span>
                <span className="w-16 text-right text-[var(--t-mute)] tabular-nums">{s.rssMb} MB</span>
              </div>
            ))}
          </section>
        )}
      </div>

      {/* logs — full width like the reference's journal card (omitted by
          older agents and systemd-less hosts) */}
      {m.logs && (
        <section className="rounded-lg border border-[var(--t-line)] bg-[var(--t-bg0)]/60 p-3">
          <div className="flex items-center font-mono text-[10px] uppercase tracking-wider text-[var(--t-dim)] mb-2">
            <span>logs</span>
            <span className="ml-auto normal-case text-[var(--t-dim)]">journal warnings+ since boot · refreshed ~60s</span>
          </div>
          <div className="flex items-center gap-3 flex-wrap font-mono text-[11px] text-[var(--t-fg2)]">
            <span>
              failed units:{" "}
              {m.logs.failedUnits.length ? (
                <span className="text-[var(--t-amber)]">{m.logs.failedUnits.join(", ")}</span>
              ) : (
                <span className="text-[var(--t-dim)]">none</span>
              )}
            </span>
            <span>
              coredumps: <span className={m.logs.coredumps ? "text-[var(--t-amber)]" : "text-[var(--t-dim)]"}>{m.logs.coredumps ?? "—"}</span>
            </span>
            {(m.mem.oomKills ?? 0) > 0 && <span className="text-[var(--t-red)]">oom kills since boot: {m.mem.oomKills}</span>}
          </div>
          {logLines === null ? (
            <div className="mt-2 font-mono text-[10px] text-[var(--t-dim)]">journal unavailable on this host</div>
          ) : logLines.length > 0 ? (
            <div className="mt-2 pt-2 border-t border-[var(--t-line)]/60 space-y-0.5 max-h-64 overflow-y-auto t-scroll">
              {logLines.map((l, i) => (
                <div
                  key={i}
                  className={cn(
                    "font-mono text-[9.5px] leading-snug whitespace-pre-wrap break-all",
                    /error|fail|panic|oom|crit|emerg|alert/i.test(l) ? "text-[var(--t-red)]/80" : /warn/i.test(l) ? "text-[var(--t-amber)]/80" : "text-[var(--t-dim)]",
                  )}
                  title={l}
                >
                  {l}
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-2 font-mono text-[10px] text-[var(--t-dim)]">no warnings or errors since boot: clean</div>
          )}
        </section>
      )}

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

/* one key/value row — the reference dashboard's .kv, truss-colored. `warn`
   paints the value amber for "worth a look" states */
function KV({ k, v, warn }: { k: string; v: ReactNode; warn?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-px">
      <span className="shrink-0 font-mono text-[10.5px] text-[var(--t-dim)]">{k}</span>
      <span className={cn("truncate text-right font-mono text-[10.5px] tabular-nums", warn ? "text-[var(--t-amber)]" : "text-[var(--t-fg2)]")} title={typeof v === "string" ? v : undefined}>
        {v}
      </span>
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
