import { useEffect, useMemo, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { store, useApp, useNow, capsOf, type Agent, type SessionView } from "@/lib/store";
import { baseHarness, fmtCost, fmtMs, fmtTokens, shortPath, ago } from "@/lib/format";
import { Btn, Empty, HarnessMark, Icon, Kbd, Select, Spinner, StateDot, TrussLogo } from "@/components/ui";
import { openDailyDriver, openFreeShell } from "@/lib/workspace";
import type { SkillInfo } from "@/lib/proto";
import { cn } from "@/utils/cn";

type P = { sessionId?: string; cwd?: string };
const CTX_REPORTERS = new Set(["pi", "dsh", "hermes"]);

function useHydrated(id?: string) {
  const meta = useApp((s) => (id ? s.sessions[id] : undefined));
  const view = useApp((s) => (id ? s.views[id] : undefined));
  useEffect(() => {
    if (id && meta) void store.ensureHydrated(id);
  }, [id, !!meta]);
  return { meta, view };
}

function PanelHead({ id, label }: { id: string; label: string }) {
  const meta = useApp((s) => s.sessions[id]);
  return (
    <div className="shrink-0 flex items-center gap-2 px-3 h-9 border-b border-[var(--t-line)]">
      <HarnessMark harness={meta.harness} size={16} />
      <span className="text-[12px] text-[var(--t-fg)] truncate">{meta.title}</span>
      <StateDot state={meta.state} size={6} />
      <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-[var(--t-dim)]">{label}</span>
    </div>
  );
}

/* ================= Context ================= */
export function ContextPanel({ params }: IDockviewPanelProps<P>) {
  const id = params.sessionId!;
  const { meta, view } = useHydrated(id);
  if (!meta) return <Empty icon="gauge" title="Session no longer exists" />;
  if (!view || view.hydration === "loading") return <div className="h-full grid place-items-center"><Spinner /></div>;
  return (
    <div className="h-full flex flex-col bg-[var(--t-bg1)] t-panel">
      <PanelHead id={id} label="context" />
      <div className="flex-1 min-h-0 overflow-auto t-scroll p-4">
        <ContextBody id={id} view={view} />
      </div>
    </div>
  );
}

function ContextBody({ id, view }: { id: string; view: SessionView }) {
  const meta = useApp((s) => s.sessions[id]);
  const h = baseHarness(meta.harness);
  const ctx = view.ctx;
  const totals = useMemo(() => {
    let tin = 0, tout = 0, cost = 0, hasTok = false, hasCost = false;
    for (const cid of view.callOrder) {
      const c = view.calls[cid];
      if (c.tokensIn !== undefined) { hasTok = true; tin += c.tokensIn; }
      if (c.tokensOut !== undefined) { hasTok = true; tout += c.tokensOut; }
      if (c.costUsd !== undefined) { hasCost = true; cost += c.costUsd; }
    }
    return { tin, tout, cost, hasTok, hasCost };
  }, [view.calls, view.callOrder]);

  if (!ctx) {
    return (
      <div className="space-y-4">
        <Empty icon="gauge" title={CTX_REPORTERS.has(h) ? "No usage reported yet" : `${meta.harness} doesn't report context usage`}>
          {CTX_REPORTERS.has(h) ? "Context occupancy appears after the first completed turn." : "Truss won't estimate what the harness doesn't report. Token and cost totals from the trajectory are below."}
        </Empty>
        <Totals {...totals} calls={view.callOrder.length} />
      </div>
    );
  }
  const pct = Math.min(1, ctx.used / Math.max(1, ctx.total));
  const color = pct > 0.85 ? "var(--t-red)" : pct > 0.6 ? "var(--t-amber)" : "var(--t-teal)";
  const R = 52, C = 2 * Math.PI * R;
  const hist = view.ctxHistory;
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-5">
        <svg width="128" height="128" viewBox="0 0 128 128" className="shrink-0">
          <circle cx="64" cy="64" r={R} fill="none" stroke="var(--t-line)" strokeWidth="10" />
          <circle cx="64" cy="64" r={R} fill="none" stroke={color} strokeWidth="10" strokeLinecap="round" strokeDasharray={`${C * pct} ${C}`} transform="rotate(-90 64 64)" style={{ transition: "stroke-dasharray .5s" }} />
          <text x="64" y="62" textAnchor="middle" className="font-mono" fontSize="24" fill="var(--t-fg)">{Math.round(pct * 100)}%</text>
          <text x="64" y="80" textAnchor="middle" className="font-mono" fontSize="10" fill="var(--t-dim)">of window</text>
        </svg>
        <div className="space-y-2 min-w-0">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--t-dim)]">used</div>
            <div className="font-mono text-[18px] text-[var(--t-fg)] tabular-nums">{ctx.used.toLocaleString()}</div>
          </div>
          <div>
            <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--t-dim)]">window</div>
            <div className="font-mono text-[13px] text-[var(--t-mute)] tabular-nums">{ctx.total.toLocaleString()} tokens</div>
          </div>
          <div className="font-mono text-[11px]" style={{ color }}>{fmtTokens(ctx.total - ctx.used)} free</div>
        </div>
      </div>

      {hist.length > 1 && (
        <div>
          <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--t-dim)] mb-1.5">occupancy over turns</div>
          <Spark points={hist.map((p) => p.used / p.total)} color={color} />
        </div>
      )}

      <div>
        <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--t-dim)] mb-1.5">breakdown</div>
        {ctx.by && Object.keys(ctx.by).length ? (
          <ByBar by={ctx.by} total={ctx.total} />
        ) : (
          <div className="text-[11.5px] text-[var(--t-mute)] leading-relaxed border border-dashed border-[var(--t-line2)] rounded-md px-3 py-2">
            {meta.harness} reports a single occupancy number — no per-category breakdown (system / tools / history). Shown as soon as a harness reports it.
          </div>
        )}
      </div>
      <Totals {...totals} calls={view.callOrder.length} />
    </div>
  );
}

function Totals({ tin, tout, cost, hasTok, hasCost, calls }: { tin: number; tout: number; cost: number; hasTok: boolean; hasCost: boolean; calls: number }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {[
        ["llm calls", String(calls)],
        ["cost", hasCost ? fmtCost(cost) : "—"],
        ["tokens in", hasTok ? fmtTokens(tin) : "—"],
        ["tokens out", hasTok ? fmtTokens(tout) : "—"],
      ].map(([k, v]) => (
        <div key={k} className="rounded-md bg-[var(--t-bg0)] border border-[var(--t-line)] px-3 py-2">
          <div className="font-mono text-[9.5px] uppercase tracking-wider text-[var(--t-dim)]">{k}</div>
          <div className="font-mono text-[14px] text-[var(--t-fg)] tabular-nums">{v}</div>
        </div>
      ))}
    </div>
  );
}

function Spark({ points, color }: { points: number[]; color: string }) {
  const W = 280, H = 48;
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${(i / (points.length - 1)) * W},${H - p * H}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-12" preserveAspectRatio="none">
      <path d={`${d} L${W},${H} L0,${H} Z`} fill={color} opacity=".12" />
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function ByBar({ by, total }: { by: Record<string, number>; total: number }) {
  const palette = ["var(--t-amber)", "var(--t-teal)", "var(--t-violet)", "var(--t-sky)", "var(--t-coral)"];
  const entries = Object.entries(by);
  return (
    <div>
      <div className="flex h-2.5 rounded overflow-hidden bg-[var(--t-line)]">
        {entries.map(([k, v], i) => <div key={k} style={{ width: `${(v / total) * 100}%`, background: palette[i % palette.length] }} title={`${k}: ${v}`} />)}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-1">
        {entries.map(([k, v], i) => (
          <div key={k} className="flex items-center gap-1.5 text-[11px] font-mono text-[var(--t-mute)]">
            <span className="w-2 h-2 rounded-sm" style={{ background: palette[i % palette.length] }} />
            {k} <span className="ml-auto tabular-nums">{fmtTokens(v)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ================= Team ================= */
export function TeamPanel({ params }: IDockviewPanelProps<P>) {
  const id = params.sessionId!;
  const { meta, view } = useHydrated(id);
  const caps = useApp((s) => (meta ? capsOf(s, meta.harness) : undefined));
  if (!meta) return <Empty icon="tree" title="Session no longer exists" />;
  if (!view || view.hydration === "loading") return <div className="h-full grid place-items-center"><Spinner /></div>;
  const roots = view.agentOrder.filter((a) => !view.agents[a].parent || !view.agents[view.agents[a].parent!]);
  return (
    <div className="h-full flex flex-col bg-[var(--t-bg1)] t-panel">
      <PanelHead id={id} label="team" />
      <div className="flex-1 min-h-0 overflow-auto t-scroll p-3">
        {!caps?.subagents ? (
          <Empty icon="tree" title={`${meta.harness} doesn't spawn subagents`}>Team trees appear for harnesses that emit subagent events — today, Claude Code's Task/Agent tool.</Empty>
        ) : roots.length === 0 ? (
          <Empty icon="tree" title="No subagents yet">When the agent delegates work (Task tool), each subagent shows up here as a live node.</Empty>
        ) : (
          <div className="font-mono text-[12px]">
            <div className="flex items-center gap-2 h-7 text-[var(--t-fg)]">
              <HarnessMark harness={meta.harness} size={16} /> main agent
            </div>
            <div className="ml-2 border-l border-[var(--t-line2)]">
              {roots.map((r) => <AgentNode key={r} a={view.agents[r]} view={view} />)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function AgentNode({ a, view }: { a: Agent; view: SessionView }) {
  const kids = view.agentOrder.filter((x) => view.agents[x].parent === a.agentId);
  const now = useNow(500, !a.done);
  return (
    <div className="pl-3 relative">
      <span className="absolute left-0 top-3.5 w-3 border-t border-[var(--t-line2)]" />
      <div className="flex items-center gap-2 h-7">
        {!a.done ? <Spinner size={11} /> : a.ok ? <Icon name="check" size={12} className="text-[var(--t-teal)]" /> : <Icon name="x" size={12} className="text-[var(--t-red)]" />}
        <span className={cn("truncate", a.done ? "text-[var(--t-fg2)]" : "text-[var(--t-amber)]")}>{a.label}</span>
        <span className="ml-auto text-[10.5px] text-[var(--t-dim)] tabular-nums">{fmtMs((a.endedAt ?? now) - a.at)}</span>
      </div>
      {kids.length > 0 && <div className="ml-1.5 border-l border-[var(--t-line2)]">{kids.map((k) => <AgentNode key={k} a={view.agents[k]} view={view} />)}</div>}
    </div>
  );
}

/* ================= Skills ================= */
export function SkillsPanel({ params }: IDockviewPanelProps<P>) {
  const session = useApp((s) => (params.sessionId ? s.sessions[params.sessionId] : undefined));
  const backend = useApp((s) => s.backend);
  const cwd = session?.cwd ?? params.cwd ?? "/";
  const [state, setState] = useState<{ loading: boolean; error?: string; skills: SkillInfo[] }>({ loading: true, skills: [] });
  const [q, setQ] = useState("");
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!backend) return;
    let off = false;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    backend.skills(cwd).then(
      (r) => !off && setState({ loading: false, skills: r.skills ?? [] }),
      (e) => !off && setState({ loading: false, skills: [], error: e.message ?? String(e) }),
    );
    return () => { off = true; };
  }, [cwd, backend, n]);
  const list = state.skills.filter((s) => !q || (s.name + s.description).toLowerCase().includes(q.toLowerCase()));
  const groups = list.reduce<Record<string, SkillInfo[]>>((acc, s) => ((acc[s.scope] ??= []).push(s), acc), {});
  return (
    <div className="h-full flex flex-col bg-[var(--t-bg1)] t-panel">
      <div className="shrink-0 flex items-center gap-2 px-3 h-9 border-b border-[var(--t-line)]">
        <Icon name="spark" size={13} className="text-[var(--t-amber)]" />
        <span className="font-mono text-[11px] text-[var(--t-mute)] truncate" title={cwd}>{shortPath(cwd)}</span>
        <div className="ml-auto flex items-center gap-1.5 h-6 px-2 rounded bg-[var(--t-bg0)] border border-[var(--t-line)]">
          <Icon name="search" size={11} className="text-[var(--t-dim)]" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter" className="w-24 bg-transparent text-[11.5px] outline-none text-[var(--t-fg)] placeholder:text-[var(--t-dim)]" />
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto t-scroll p-3">
        {state.loading ? (
          <div className="h-full grid place-items-center"><Spinner /></div>
        ) : state.error ? (
          <Empty icon="alert" title="Couldn't list skills">
            <span className="font-mono text-[11px] text-[var(--t-red)] break-all">{state.error}</span>
            <div className="mt-3"><Btn variant="outline" icon="retry" onClick={() => setN((x) => x + 1)}>Retry</Btn></div>
          </Empty>
        ) : list.length === 0 ? (
          <Empty icon="spark" title="No skills visible">No Agent-Skills directories are visible from this working directory.</Empty>
        ) : (
          Object.entries(groups).map(([scope, items]) => (
            <div key={scope} className="mb-4">
              <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--t-dim)] mb-1.5">{scope} · {items.length}</div>
              <div className="space-y-1.5">
                {items.map((s) => (
                  <div key={s.source + s.name} className="rounded-md border border-[var(--t-line)] bg-[var(--t-bg0)]/60 px-3 py-2 hover:border-[var(--t-line2)]">
                    <div className="font-mono text-[12px] text-[var(--t-amber)]">{s.name}</div>
                    <div className="text-[12px] text-[var(--t-fg2)] mt-0.5 leading-snug">{s.description}</div>
                    <div className="font-mono text-[10.5px] text-[var(--t-dim)] mt-1 truncate" title={s.source}>{shortPath(s.source)}</div>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/* ================= Welcome ================= */
export function WelcomePanel() {
  const order = useApp((s) => s.order);
  const sessions = useApp((s) => s.sessions);
  const mode = useApp((s) => s.backend?.mode);
  const recent = order.slice(0, 4).map((i) => sessions[i]).filter(Boolean);
  const now = useNow(30_000);
  return (
    <div className="h-full overflow-auto t-scroll bg-[var(--t-bg1)] t-grid-bg">
      <div className="max-w-[640px] mx-auto px-6 py-12">
        <div className="text-[var(--t-amber)]"><TrussLogo size={30} /></div>
        <h1 className="mt-4 text-[26px] leading-tight font-semibold text-[var(--t-fg)] tracking-tight">One head for every harness.</h1>
        <p className="mt-2 text-[13.5px] text-[var(--t-mute)] leading-relaxed max-w-[520px]">
          Run pi, Claude Code, DeepSeek Harness and Hermes side by side. Watch them stream, answer their permission requests, and trace every LLM call in the trajectory.
        </p>
        <div className="mt-6 flex flex-wrap gap-2">
          <Btn variant="amber" size="md" icon="plus" onClick={() => window.dispatchEvent(new Event("truss:new"))}>New session <Kbd>N</Kbd></Btn>
          <Btn variant="outline" size="md" icon="term" onClick={() => openFreeShell()}>Free shell</Btn>
        </div>
        {recent.length > 0 && (
          <div className="mt-10">
            <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--t-dim)] mb-2">jump back in</div>
            <div className="grid sm:grid-cols-2 gap-2">
              {recent.map((s) => (
                <button key={s.id} onClick={() => openDailyDriver(s.id)} className="text-left rounded-lg border border-[var(--t-line)] bg-[var(--t-bg0)]/70 hover:border-[var(--t-line2)] px-3 py-2.5 group">
                  <div className="flex items-center gap-2">
                    <HarnessMark harness={s.harness} size={18} />
                    <span className="truncate text-[12.5px] text-[var(--t-fg)] flex-1">{s.title}</span>
                    <StateDot state={s.state} size={7} />
                  </div>
                  <div className="mt-1 font-mono text-[10.5px] text-[var(--t-dim)] truncate">{shortPath(s.cwd)} · {ago(+new Date(s.updated_at), now)}</div>
                  <div className="mt-1.5 text-[10.5px] text-[var(--t-mute)] opacity-0 group-hover:opacity-100 transition-opacity">open chat · trajectory · context →</div>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="mt-10 text-[11px] text-[var(--t-dim)] flex flex-wrap gap-x-4 gap-y-1">
          <span><Kbd>N</Kbd> new session</span>
          <span><Kbd>⌘</Kbd><Kbd>K</Kbd> jump anywhere</span>
          <span>drag tabs to arrange · layout persists</span>
        </div>
        {mode === "demo" && (
          <div className="mt-8 text-[12px] text-[var(--t-dim)] leading-relaxed max-w-[520px]">
            No Truss server answered <span className="font-code">/health</span>, so harnesses are simulated in-browser against the real event contract. Try “audit with a team” on Claude Code, “write a file” on dsh (permission card), or the restart button in the status bar.
          </div>
        )}
      </div>
    </div>
  );
}

/* ================= Cost ================= */

interface CostRow {
  id: string;
  title: string;
  harness: string;
  state: string;
  updated_at: number;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
}
interface CostData {
  sessions: CostRow[];
  totals: { calls: number; tokensIn: number; tokensOut: number; costUsd: number; hasCost: boolean };
}

/** Global cost + token ledger across all sessions (server-aggregated). */
export function CostPanel() {
  const [data, setData] = useState<CostData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [at, setAt] = useState<number>(0);
  const now = useNow(30_000);

  const load = () => {
    if (!store.be) return;
    store.be.costs().then((d) => { setData(d); setErr(null); setAt(Date.now()); }).catch((e) => setErr(e.message ?? String(e)));
  };
  useEffect(load, [store.be]);
  /* live-ish: refetch when a llm.call.done lands anywhere */
  const tick = useApp((s) => Object.values(s.views).reduce((n, v) => n + v.callOrder.filter((c) => v.calls[c].done).length, 0));
  useEffect(() => { if (tick > 0) load(); }, [tick]);

  if (err) return <Empty icon="alert" title="Couldn't load costs">{err}</Empty>;
  if (!data) return <div className="h-full grid place-items-center"><Spinner /></div>;

  const t = data.totals;
  const withCost = data.sessions.filter((s) => s.costUsd != null);
  return (
    <div className="h-full flex flex-col bg-[var(--t-bg1)] t-panel">
      <div className="shrink-0 flex items-center gap-2 px-3 h-9 border-b border-[var(--t-line)]">
        <Icon name="cost" size={13} className="text-[var(--t-amber)]" />
        <span className="text-[12px] text-[var(--t-fg)] font-medium">Cost & tokens</span>
        <span className="ml-auto font-mono text-[10px] text-[var(--t-dim)]">
          {at ? `updated ${ago(at, now)}` : ""}
        </span>
        <Btn size="xs" variant="ghost" icon="retry" onClick={load} title="Refresh from the server">Refresh</Btn>
      </div>
      <div className="flex-1 min-h-0 overflow-auto t-scroll">
        <div className="p-4 pb-2 flex items-end gap-6 flex-wrap">
          <div>
            <div className="text-[24px] font-semibold tabular-nums text-[var(--t-fg)]">{t.hasCost ? fmtCost(t.costUsd) : "—"}</div>
            <div className="text-[10.5px] uppercase tracking-wider text-[var(--t-dim)]">total reported cost</div>
          </div>
          <div>
            <div className="text-[16px] font-medium tabular-nums text-[var(--t-fg2)]">{t.calls.toLocaleString()}</div>
            <div className="text-[10.5px] uppercase tracking-wider text-[var(--t-dim)]">llm calls</div>
          </div>
          <div>
            <div className="text-[16px] font-medium tabular-nums text-[var(--t-fg2)]">{fmtTokens(t.tokensIn)} → {fmtTokens(t.tokensOut)}</div>
            <div className="text-[10.5px] uppercase tracking-wider text-[var(--t-dim)]">tokens in → out</div>
          </div>
        </div>
        {!t.hasCost && (
          <div className="mx-4 mb-3 rounded-md border border-[var(--t-line)] bg-[var(--t-bg2)] px-3 py-2 text-[11px] text-[var(--t-mute)]">
            No harness has reported cost yet — pi and claude-code report per-call cost; dsh and hermes report tokens only. Token columns are always real.
          </div>
        )}
        <div className="px-2 pb-4">
          <div className="grid grid-cols-[1fr_64px_72px_64px_56px] gap-2 px-2 h-7 items-center text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--t-dim)] border-b border-[var(--t-line)]">
            <span>session</span><span className="text-right">calls</span><span className="text-right">in → out</span><span className="text-right">cost</span><span></span>
          </div>
          {data.sessions.map((s) => (
            <button
              key={s.id}
              onClick={() => openDailyDriver(s.id)}
              className="w-full grid grid-cols-[1fr_64px_72px_64px_56px] gap-2 px-2 h-8 items-center text-left border-b border-[var(--t-line)]/50 hover:bg-white/[0.03] transition-colors"
              title={`${s.title}\n${s.harness} · open chat + trajectory + context`}
            >
              <span className="flex items-center gap-2 min-w-0">
                <HarnessMark harness={s.harness} size={14} />
                <span className="truncate text-[12px] text-[var(--t-fg2)]">{s.title}</span>
                <StateDot state={s.state as never} size={5} />
              </span>
              <span className="text-right font-mono text-[11px] tabular-nums text-[var(--t-mute)]">{s.calls}</span>
              <span className="text-right font-mono text-[11px] tabular-nums text-[var(--t-mute)]">{fmtTokens(s.tokensIn)} → {fmtTokens(s.tokensOut)}</span>
              <span className={cn("text-right font-mono text-[11px] tabular-nums", s.costUsd != null ? "text-[var(--t-amber)]" : "text-[var(--t-dim)]")}>
                {s.costUsd != null ? fmtCost(s.costUsd) : "—"}
              </span>
              <span />
            </button>
          ))}
          {withCost.length === 0 && data.sessions.length === 0 && (
            <Empty icon="gauge" title="No LLM calls yet">Run a session and the ledger fills in.</Empty>
          )}
        </div>
      </div>
    </div>
  );
}

/* ================= Credentials (dsh-key-proxy) ================= */

interface RouteView {
  port: number;
  host: string;
  scheme: string;
  upstreamPort: number;
  auth: string;
  enabled: boolean;
  allowedModels?: string[];
  description?: string;
  hasKey: boolean;
}
interface CredData { routes: RouteView[]; service: string; serviceActive: boolean }

export function CredentialsPanel() {
  const [data, setData] = useState<CredData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ port: "", host: "", key: "", auth: "bearer", description: "" });
  const [showForm, setShowForm] = useState(false);
  const be = useApp((s) => s.backend);
  const load = () => {
    if (!be) return;
    be.credentials().then((d: CredData) => setData(d)).catch((e: any) => setErr(e.message ?? String(e)));
  };
  useEffect(load, [be]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); load(); } catch (e: any) { setErr(e.message ?? String(e)); } finally { setBusy(false); }
  };

  if (err && !data) return <Empty icon="alert" title="Couldn't read credentials">{err}</Empty>;
  if (!data) return <div className="h-full grid place-items-center"><Spinner /></div>;

  return (
    <div className="h-full flex flex-col bg-[var(--t-bg1)] t-panel">
      <div className="shrink-0 flex items-center gap-2 px-3 h-9 border-b border-[var(--t-line)]">
        <Icon name="lock" size={13} className="text-[var(--t-amber)]" />
        <span className="text-[12px] text-[var(--t-fg)] font-medium">Credentials</span>
        <span className={cn("inline-block w-1.5 h-1.5 rounded-full", data.serviceActive ? "bg-[var(--t-teal)]" : "bg-[var(--t-red)]")} />
        <span className="text-[10.5px] text-[var(--t-dim)] font-mono">{data.service}</span>
        <span className="ml-auto" />
        <Btn size="xs" variant="ghost" icon="retry" onClick={() => act(() => be!.credentialsService("restart"))} disabled={busy} title="Restart the key-proxy after external edits">Restart</Btn>
        <Btn size="xs" variant="outline" icon="plus" onClick={() => setShowForm((v) => !v)}>Add route</Btn>
      </div>
      <div className="flex-1 min-h-0 overflow-auto t-scroll">
        <div className="px-4 pt-2.5 pb-1 text-[11px] text-[var(--t-dim)] leading-relaxed">
          Provider keys live only in the key-proxy file (<span className="font-mono">~/.dsh/bin/dsh-key-proxy.json</span>, owner-read only). Harnesses call loopback ports; the proxy injects the real key upstream. Keys are write-only here — never displayed.
        </div>
        {err && <div className="mx-4 mt-2 rounded-md border border-[color-mix(in_oklab,var(--t-red)_25%,transparent)] bg-[color-mix(in_oklab,var(--t-red)_9%,transparent)] px-3 py-2 text-[11.5px] text-[var(--t-red)]">{err}</div>}
        {showForm && (
          <div className="mx-4 mt-2 mb-1 rounded-lg border border-[var(--t-line2)] bg-[var(--t-bg2)] p-3 grid grid-cols-[88px_1fr_120px] gap-2 items-center">
            <input className="t-input font-mono" placeholder="port" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
            <input className="t-input font-mono" placeholder="upstream host (api.example.com)" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />
            <Select className="w-full" value={form.auth} onChange={(v) => setForm({ ...form, auth: v })} ariaLabel="Auth style" options={[{ value: "bearer", label: "bearer" }, { value: "x-api-key", label: "x-api-key" }]} />
            <input className="t-input font-mono col-span-2" placeholder="description (optional)" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            <input className="t-input font-mono" type="password" placeholder="API key (write-only)" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} autoComplete="off" />
            <div className="col-span-3 flex justify-end gap-2">
              <Btn size="xs" variant="ghost" onClick={() => setShowForm(false)}>Cancel</Btn>
              <Btn size="xs" variant="amber" disabled={busy || !form.port || !form.host} onClick={() => act(async () => {
                await be!.upsertCredential({ port: Number(form.port), host: form.host, auth: form.auth, description: form.description || undefined, key: form.key || undefined });
                setShowForm(false); setForm({ port: "", host: "", key: "", auth: "bearer", description: "" });
              })}>Save + restart</Btn>
            </div>
          </div>
        )}
        <div className="px-2 pb-3 pt-1">
          {data.routes.map((r) => (
            <div key={r.port} className={cn("group flex items-center gap-2.5 px-2 py-1.5 rounded-md hover:bg-white/[0.03]", !r.enabled && "opacity-50")}>
              <span className={cn("font-mono text-[11px] tabular-nums w-[52px]", r.enabled ? "text-[var(--t-teal)]" : "text-[var(--t-dim)]")}>:{r.port}</span>
              <span className="font-mono text-[12px] text-[var(--t-fg2)] truncate">{r.host}</span>
              {r.scheme === "http" && <span className="text-[9px] font-mono uppercase px-1 rounded bg-[var(--t-amber)]/15 text-[var(--t-amber)]">http</span>}
              {r.allowedModels && <span className="text-[9px] font-mono px-1 rounded bg-[var(--t-violet)]/15 text-[var(--t-violet)]" title={r.allowedModels.join(", ")}>allowlist</span>}
              {r.description && <span className="text-[10.5px] text-[var(--t-dim)] truncate">{r.description}</span>}
              <span className="ml-auto flex items-center gap-1.5 shrink-0">
                <span className={cn("text-[10px] font-mono px-1.5 rounded", r.hasKey ? "bg-[var(--t-teal)]/12 text-[var(--t-teal)]" : "bg-[var(--t-red)]/12 text-[var(--t-red)]")}>{r.hasKey ? "key set" : "no key"}</span>
                <button
                  className="opacity-0 group-hover:opacity-70 hover:!opacity-100 text-[var(--t-mute)] hover:text-[var(--t-fg)] p-1"
                  title={r.enabled ? "Disable route (keep config)" : "Enable route"}
                  onClick={() => act(() => be!.upsertCredential({ port: r.port, host: r.host, enabled: !r.enabled }))}
                ><Icon name="power" size={11} /></button>
                <button
                  className="opacity-0 group-hover:opacity-70 hover:!opacity-100 text-[var(--t-mute)] hover:text-[var(--t-red)] p-1"
                  title="Remove route (its key is deleted from the file)"
                  onClick={() => act(() => be!.deleteCredential(r.port))}
                ><Icon name="trash" size={11} /></button>
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ================= Router (9router + harness routing) ================= */

interface RouterData {
  service: string;
  active: boolean;
  port: number;
  models: { id: string; owned_by?: string; capabilities?: Record<string, unknown>; context_length?: number }[];
  providers: { id: string; models: number }[];
  catalogSyncedAt?: string;
  harnesses: { harness: string; model?: string; provider?: string; endpoint?: string; source: string }[];
}

export function RouterPanel() {
  const [data, setData] = useState<RouterData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const be = useApp((s) => s.backend);
  const load = () => {
    if (!be) return;
    be.router().then((d: RouterData) => setData(d)).catch((e: any) => setErr(e.message ?? String(e)));
  };
  useEffect(load, [be]);

  if (err && !data) return <Empty icon="alert" title="Couldn't read the router">{err}</Empty>;
  if (!data) return <div className="h-full grid place-items-center"><Spinner /></div>;

  const models = data.models.filter((m) => !q || m.id.toLowerCase().includes(q.toLowerCase()));
  const ctl = async (action: string) => {
    setBusy(true);
    try { await be!.routerService(action); load(); } catch (e: any) { setErr(e.message ?? String(e)); } finally { setBusy(false); }
  };

  return (
    <div className="h-full flex flex-col bg-[var(--t-bg1)] t-panel">
      <div className="shrink-0 flex items-center gap-2 px-3 h-9 border-b border-[var(--t-line)]">
        <Icon name="host" size={13} className="text-[var(--t-sky)]" />
        <span className="text-[12px] text-[var(--t-fg)] font-medium">Model router</span>
        <span className={cn("inline-block w-1.5 h-1.5 rounded-full", data.active ? "bg-[var(--t-teal)]" : "bg-[var(--t-red)]")} />
        <span className="text-[10.5px] text-[var(--t-dim)] font-mono">:{data.port}</span>
        <span className="ml-auto" />
        {data.active ? (
          <>
            <Btn size="xs" variant="ghost" icon="restart" onClick={() => ctl("restart")} disabled={busy}>Restart</Btn>
            <Btn size="xs" variant="ghost" icon="stop" onClick={() => ctl("stop")} disabled={busy}>Stop</Btn>
          </>
        ) : (
          <Btn size="xs" variant="amber" icon="power" onClick={() => ctl("start")} disabled={busy}>Start router</Btn>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-auto t-scroll">
        <div className="p-4 pb-2">
          <div className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-[var(--t-dim)] mb-1.5">Harness routing</div>
          <div className="rounded-lg border border-[var(--t-line)] overflow-hidden">
            {data.harnesses.map((h, i) => (
              <div key={i} className="flex items-center gap-2.5 px-3 py-1.5 border-b border-[var(--t-line)]/50 last:border-b-0">
                <HarnessMark harness={h.harness} size={15} />
                <span className="text-[12px] text-[var(--t-fg2)] w-24 shrink-0">{h.harness}</span>
                <span className="font-mono text-[11px] text-[var(--t-fg)] truncate">{h.model ?? "—"}</span>
                <span className="font-mono text-[10.5px] text-[var(--t-dim)] truncate flex-1">{h.endpoint ?? h.provider ?? ""}</span>
                <span className="text-[9.5px] font-mono text-[var(--t-dim)] shrink-0" title={h.source}>{h.source.replace(/^~\//, "~/")}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="px-4 pb-2">
          <div className="flex items-center mb-1.5">
            <div className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-[var(--t-dim)]">Catalog · {data.models.length} models{data.catalogSyncedAt ? "" : " (live)"}</div>
            <div className="ml-auto flex items-center gap-1.5 h-6 px-2 rounded bg-[var(--t-bg0)] border border-[var(--t-line)]">
              <Icon name="search" size={10} className="text-[var(--t-dim)]" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter" className="w-24 bg-transparent text-[11px] outline-none text-[var(--t-fg)] placeholder:text-[var(--t-dim)]" />
            </div>
          </div>
          <div className="rounded-lg border border-[var(--t-line)] overflow-hidden">
            {models.slice(0, 200).map((m) => (
              <div key={m.id} className="flex items-center gap-2.5 px-3 py-1 border-b border-[var(--t-line)]/40 last:border-b-0">
                <span className="font-mono text-[11px] text-[var(--t-fg2)] truncate flex-1">{m.id}</span>
                {!!m.capabilities?.tools && <span className="text-[9px] font-mono px-1 rounded bg-[var(--t-sky)]/15 text-[var(--t-sky)]">tools</span>}
                {!!m.capabilities?.vision && <span className="text-[9px] font-mono px-1 rounded bg-[var(--t-violet)]/15 text-[var(--t-violet)]">vision</span>}
                {!!m.capabilities?.reasoning && <span className="text-[9px] font-mono px-1 rounded bg-[var(--t-amber)]/15 text-[var(--t-amber)]">reasoning</span>}
                {!!m.context_length && <span className="text-[9.5px] font-mono text-[var(--t-dim)] tabular-nums">{fmtTokens(m.context_length)}</span>}
              </div>
            ))}
            {models.length === 0 && <div className="px-3 py-4 text-center text-[11.5px] text-[var(--t-dim)]">{data.active ? "No models match." : "Router is stopped — start it to load the live catalog."}</div>}
          </div>
          <div className="mt-2 text-[10.5px] text-[var(--t-dim)] leading-relaxed">
            Provider keys for the router's upstreams are managed in the 9router dashboard (its own auth) — this panel covers the catalog, service, and where harnesses point.
          </div>
        </div>
      </div>
    </div>
  );
}
