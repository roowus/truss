import { useEffect, useMemo, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { store, useApp, useNow, capsOf, type Agent, type SessionView } from "@/lib/store";
import { baseHarness, fmtCost, fmtMs, fmtTokens, shortPath, ago } from "@/lib/format";
import { harnessDisplay, hostAliases } from "@/lib/device";
import { useDesktops } from "@/lib/desktops";
import { Btn, Empty, HarnessMark, Icon, Kbd, Select, Spinner, StateDot, TrussLogo } from "@/components/ui";
import { openDailyDriver, openFreeShell } from "@/lib/workspace";
import { costsRefreshDue, heatTooltip } from "@/lib/heatGrid";
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
  const hosts = useApp((s) => s.hosts);
  const hostPrefs = useDesktops((s) => s.hosts);
  const harnessName = harnessDisplay(meta.harness, hosts, hostAliases(hostPrefs));
  const h = baseHarness(meta.harness);
  const ctx = view.ctx;
  const totals = useMemo(() => {
    let tin = 0, tout = 0, cost = 0, hasTok = false, hasCost = false, cacheRead = 0, cacheWrite = 0, hasCache = false;
    for (const cid of view.callOrder) {
      const c = view.calls[cid];
      if (c.tokensIn !== undefined) { hasTok = true; tin += c.tokensIn; }
      if (c.tokensOut !== undefined) { hasTok = true; tout += c.tokensOut; }
      if (c.costUsd !== undefined) { hasCost = true; cost += c.costUsd; }
      if (c.cacheRead !== undefined || c.cacheWrite !== undefined) { hasCache = true; cacheRead += c.cacheRead ?? 0; cacheWrite += c.cacheWrite ?? 0; }
    }
    const userMsgs = Object.values(view.msgs).filter((m) => m.role === "user").length;
    const toolCalls = Object.keys(view.tools).length;
    /* cache hit of all input-side tokens (claude reports input excl. cache;
       pi reports it alongside — the union denominator is the safe read).
       only shown when the harness reports cache fields at all (hasCache) */
    const cacheDenom = tin + cacheRead + cacheWrite;
    const cacheHit = hasCache && cacheDenom > 0 ? Math.min(1, cacheRead / cacheDenom) : undefined;
    return { tin, tout, cost, hasTok, hasCost, cacheRead, cacheWrite, cacheHit, userMsgs, toolCalls };
  }, [view.calls, view.callOrder, view.msgs, view.tools]);

  if (!ctx) {
    return (
      <div className="space-y-4">
        <Empty icon="gauge" title={CTX_REPORTERS.has(h) ? "No usage reported yet" : `${harnessName} doesn't report context usage`}>
          {CTX_REPORTERS.has(h) ? "Context occupancy appears after the first completed turn." : "Truss won't estimate what the harness doesn't report. Token and cost totals from the trajectory are below."}
        </Empty>
        <StatsRow {...totals} calls={view.callOrder.length} />
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
      <StatsRow {...totals} calls={view.callOrder.length} />
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
            {harnessName} reports a single occupancy number — no per-category breakdown (system / tools / history). Shown as soon as a harness reports it.
          </div>
        )}
      </div>
      <Totals {...totals} calls={view.callOrder.length} />
    </div>
  );
}

/** dsh-context style stat tiles: turns, steps, tool calls, cache hit, cost */
function StatsRow({ userMsgs, toolCalls, cacheHit, cost, hasCost, calls }: {
  userMsgs: number; toolCalls: number; cacheHit?: number; cost: number; hasCost: boolean; calls: number;
}) {
  const tiles: [string, string][] = [
    ["turns", String(userMsgs)],
    ["llm calls", String(calls)],
    ["tool calls", String(toolCalls)],
    ["cache hit", cacheHit === undefined ? "—" : `${(cacheHit * 100).toFixed(1)}%`],
    ["cost", hasCost ? fmtCost(cost) : "—"],
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 2xl:grid-cols-5 gap-2">
      {tiles.map(([k, v]) => (
        <div key={k} className="rounded-md bg-[var(--t-bg0)] border border-[var(--t-line)] px-3 py-2 min-w-0">
          <div className="font-mono text-[9.5px] uppercase tracking-wider text-[var(--t-dim)] truncate">{k}</div>
          <div className="font-mono text-[14px] text-[var(--t-fg)] tabular-nums truncate">{v}</div>
        </div>
      ))}
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

export function Spark({ points, color }: { points: number[]; color: string }) {
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
  const hosts = useApp((s) => s.hosts);
  const hostPrefs = useDesktops((s) => s.hosts);
  if (!meta) return <Empty icon="tree" title="Session no longer exists" />;
  if (!view || view.hydration === "loading") return <div className="h-full grid place-items-center"><Spinner /></div>;
  const harnessName = harnessDisplay(meta.harness, hosts, hostAliases(hostPrefs));
  const roots = view.agentOrder.filter((a) => !view.agents[a].parent || !view.agents[view.agents[a].parent!]);
  return (
    <div className="h-full flex flex-col bg-[var(--t-bg1)] t-panel">
      <PanelHead id={id} label="team" />
      <div className="flex-1 min-h-0 overflow-auto t-scroll p-3">
        {!caps?.subagents ? (
          <Empty icon="tree" title={`${harnessName} doesn't spawn subagents`}>Team trees appear for harnesses that emit subagent events — today, Claude Code's Task/Agent tool.</Empty>
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
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", description: "" });
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

  const act = async (key: string, fn: () => Promise<unknown>) => {
    if (!backend) return;
    setBusy(key);
    try {
      await fn();
      setN((x) => x + 1);
    } catch (e: any) {
      setState((s) => ({ ...s, error: e.message ?? String(e) }));
    } finally {
      setBusy(null);
      setConfirmDel(null);
    }
  };

  const list = state.skills.filter((s) => !q || (s.name + s.description).toLowerCase().includes(q.toLowerCase()));
  const groups = list.reduce<Record<string, SkillInfo[]>>((acc, s) => ((acc[s.scope] ??= []).push(s), acc), {});
  return (
    <div className="h-full flex flex-col bg-[var(--t-bg1)] t-panel">
      <div className="shrink-0 flex items-center gap-2 px-3 h-9 border-b border-[var(--t-line)]">
        <Icon name="spark" size={13} className="text-[var(--t-amber)]" />
        <span className="font-mono text-[11px] text-[var(--t-mute)] truncate" title={cwd}>{shortPath(cwd)}</span>
        <div className="ml-auto flex items-center gap-1">
          <div className="flex items-center gap-1.5 h-6 px-2 rounded bg-[var(--t-bg0)] border border-[var(--t-line)]">
            <Icon name="search" size={11} className="text-[var(--t-dim)]" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter" className="w-24 bg-transparent text-[11.5px] outline-none text-[var(--t-fg)] placeholder:text-[var(--t-dim)]" />
          </div>
          <Btn size="xs" variant="outline" icon="plus" title="New project skill (.agents/skills)" onClick={() => setCreating((v) => !v)} />
        </div>
      </div>
      {creating && (
        <div className="shrink-0 border-b border-[var(--t-line)] bg-[var(--t-bg2)] px-3 py-2 flex items-center gap-2">
          <input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="skill name" className="t-input w-36" />
          <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} onKeyDown={(e) => e.key === "Enter" && form.name.trim() && act("new", () => backend!.createSkill(cwd, form.name, form.description)).then(() => { setCreating(false); setForm({ name: "", description: "" }); })} placeholder="description (when-to-use)" className="t-input flex-1" />
          <Btn size="xs" variant="amber" disabled={busy === "new" || !form.name.trim()} onClick={() => act("new", () => backend!.createSkill(cwd, form.name, form.description)).then(() => { setCreating(false); setForm({ name: "", description: "" }); })}>Create</Btn>
          <Btn size="xs" variant="ghost" onClick={() => setCreating(false)}>Cancel</Btn>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-auto t-scroll p-3">
        {state.loading ? (
          <div className="h-full grid place-items-center"><Spinner /></div>
        ) : state.error && state.skills.length === 0 ? (
          <Empty icon="alert" title="Couldn't list skills">
            <span className="font-mono text-[11px] text-[var(--t-red)] break-all">{state.error}</span>
            <div className="mt-3"><Btn variant="outline" icon="retry" onClick={() => setN((x) => x + 1)}>Retry</Btn></div>
          </Empty>
        ) : list.length === 0 ? (
          <Empty icon="spark" title="No skills visible">No Agent-Skills directories are visible from this working directory. Create one with + above.</Empty>
        ) : (
          <>
            {state.error && <div className="mb-2 rounded-md border border-[color-mix(in_oklab,var(--t-red)_25%,transparent)] px-2.5 py-1.5 text-[11px] font-mono text-[var(--t-red)]">{state.error}</div>}
            {Object.entries(groups).map(([scope, items]) => (
            <div key={scope} className="mb-4">
              <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--t-dim)] mb-1.5">{scope} · {items.length}</div>
              <div className="space-y-1.5">
                {items.map((s) => (
                  <div key={s.source + s.name} className={cn("group rounded-md border border-[var(--t-line)] bg-[var(--t-bg0)]/60 px-3 py-2 hover:border-[var(--t-line2)]", s.disabled && "opacity-55")}>
                    <div className="flex items-center gap-2">
                      <div className="font-mono text-[12px] text-[var(--t-amber)] truncate">{s.name}</div>
                      <span className="ml-auto shrink-0 flex items-center gap-1">
                        <button
                          role="switch"
                          aria-checked={!s.disabled}
                          aria-label={`${s.disabled ? "Enable" : "Disable"} ${s.name} for the model`}
                          title={s.disabled ? "Disabled — the model can't invoke it. Click to enable." : "Enabled — the model can invoke it. Click to disable."}
                          disabled={busy === s.source}
                          onClick={() => act(s.source, () => backend!.toggleSkill(s.source, !s.disabled))}
                          className={cn("w-7 h-4 rounded-full relative transition-colors", s.disabled ? "bg-[var(--t-line2)]" : "bg-[var(--t-teal)]/70")}
                        >
                          <span className={cn("absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all", s.disabled ? "left-0.5" : "left-3.5")} />
                        </button>
                        {confirmDel === s.source ? (
                          <button onClick={() => act(s.source, () => backend!.deleteSkill(s.source))} className="text-[10px] font-mono text-[var(--t-red)] hover:underline shrink-0">trash?</button>
                        ) : (
                          <button
                            onClick={() => setConfirmDel(s.source)}
                            aria-label={`Move ${s.name} to trash`}
                            title="Move to .trash (recoverable)"
                            className="opacity-0 group-hover:opacity-70 hover:!opacity-100 text-[var(--t-mute)] hover:text-[var(--t-red)] p-0.5"
                          >
                            <Icon name="trash" size={11} />
                          </button>
                        )}
                      </span>
                    </div>
                    <div className="text-[12px] text-[var(--t-fg2)] mt-0.5 leading-snug">{s.description}</div>
                    <div className="font-mono text-[10.5px] text-[var(--t-dim)] mt-1 truncate" title={s.source}>{shortPath(s.source)}{s.disabled && <span className="ml-1.5 text-[var(--t-coral)]">· disabled</span>}</div>
                  </div>
                ))}
              </div>
            </div>
            ))}
          </>
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

interface DayRow {
  day: string; // YYYY-MM-DD local
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
}

/** Global cost + token ledger across all sessions (server-aggregated). */
export function CostPanel() {
  const hosts = useApp((s) => s.hosts);
  const hostPrefs = useDesktops((s) => s.hosts);
  const [data, setData] = useState<CostData | null>(null);
  const [days, setDays] = useState<DayRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [at, setAt] = useState<number>(0);
  const now = useNow(30_000);

  const load = () => {
    if (!store.be) return;
    store.be.costs().then((d) => { setData(d); setErr(null); setAt(Date.now()); }).catch((e) => setErr(e.message ?? String(e)));
    store.be.costsDaily().then((d) => setDays(d.days)).catch(() => {});
  };
  useEffect(load, [store.be]);
  /* live-ish: refetch when a llm.call.done lands anywhere */
  const tick = useApp((s) => Object.values(s.views).reduce((n, v) => n + v.callOrder.filter((c) => v.calls[c].done).length, 0));
  useEffect(() => { if (tick > 0) load(); }, [tick]);
  /* time-based refetch (issue #158): the tick only counts dones in hydrated
     views, so work in chats you haven't opened never landed, and a panel
     left open overnight showed yesterday forever. The 30s clock re-checks
     the staleness window, so new usage shows up within a couple minutes
     regardless of which chats are open. */
  useEffect(() => {
    if (at > 0 && costsRefreshDue({ lastFetchAt: at, now })) load();
  }, [now, at]);

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
          {days && days.length > 0 && <DayTotals days={days} />}
        </div>
        {days && days.length > 0 && <HeatGrid days={days} now={now} />}
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
              title={`${s.title}\n${harnessDisplay(s.harness, hosts, hostAliases(hostPrefs))} · open chat + trajectory + context`}
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

/* rolling windows from the daily buckets (today / 7d / 30d) */
function DayTotals({ days }: { days: DayRow[] }) {
  const sum = (rows: DayRow[]) => rows.reduce(
    (a, d) => ({
      calls: a.calls + d.calls,
      tokens: a.tokens + d.tokensIn + d.tokensOut,
      cost: a.cost + (d.costUsd ?? 0),
      hasCost: a.hasCost || d.costUsd != null,
    }),
    { calls: 0, tokens: 0, cost: 0, hasCost: false },
  );
  const today = sum(days.slice(-1));
  const week = sum(days.slice(-7));
  const month = sum(days.slice(-30));
  const cells: [string, ReturnType<typeof sum>][] = [["today", today], ["7 days", week], ["30 days", month]];
  return (
    <>
      {cells.map(([label, v]) => (
        <div key={label}>
          <div className="text-[16px] font-medium tabular-nums text-[var(--t-fg2)]">
            {v.hasCost ? fmtCost(v.cost) : fmtTokens(v.tokens)}
            <span className="ml-1 text-[10px] text-[var(--t-dim)]">{v.calls} calls{v.hasCost ? "" : " · tokens"}</span>
          </div>
          <div className="text-[10.5px] uppercase tracking-wider text-[var(--t-dim)]">{label}</div>
        </div>
      ))}
    </>
  );
}

/** Codex-style 5-week usage heat grid (intensity = total tokens that day).
    `now` comes in as a prop (the panel's 30s tick), so "today" rolls at
    midnight without a data change; the cell tooltip is the styled instant
    kind (issue #158), not the slow native title. */
function HeatGrid({ days, now }: { days: DayRow[]; now: number }) {
  const byDay = new Map(days.map((d) => [d.day, d]));
  /* build 35 cells ending today, week-aligned (oldest first, column per week) */
  const todayD = new Date(now);
  const cells: (DayRow | null)[] = [];
  const start = new Date(todayD);
  start.setDate(start.getDate() - (34 + todayD.getDay() % 7));
  for (let i = 0; ; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    if (d > todayD) break;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    cells.push(byDay.get(key) ?? { day: key, calls: 0, tokensIn: 0, tokensOut: 0, costUsd: null });
  }
  const max = Math.max(1, ...cells.map((c) => (c ? c.tokensIn + c.tokensOut : 0)));
  const weeks: (DayRow | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return (
    <div className="px-4 pb-3">
      <div className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-[var(--t-dim)] mb-1.5">last 5 weeks</div>
      <div className="flex gap-[3px]">
        {weeks.map((w, i) => (
          <div key={i} className="flex flex-col gap-[3px]">
            {w.map((d, j) => {
              if (!d) return <span key={`pad${j}`} className="w-3 h-3" />;
              const tok = d.tokensIn + d.tokensOut;
              const p = tok === 0 ? 0 : Math.max(0.18, tok / max);
              const tip = heatTooltip(d);
              return (
                <span key={d.day} className="relative group">
                  {/* role + tabIndex keep the cell's info reachable from the
                      keyboard and screen readers (audit round 1 B1) — the
                      native title this replaces was at least focus-surfaced */}
                  <span
                    role="img"
                    aria-label={tip}
                    tabIndex={0}
                    className="block w-3 h-3 rounded-[3px] border border-[var(--t-line)]/60 group-hover:border-[var(--t-amber)] focus-visible:outline-1 focus-visible:outline-[var(--t-amber)]"
                    style={{ background: tok === 0 ? "var(--t-bg0)" : `color-mix(in oklab, var(--t-amber) ${Math.round(p * 100)}%, var(--t-bg0))` }}
                  />
                  {/* GitHub-style tooltip: instant on hover or keyboard focus,
                      anchored to the cell (left-aligned except the last
                      column, which flips so it can't run off the panel edge) */}
                  <span className={`pointer-events-none absolute bottom-full mb-1.5 z-40 hidden group-hover:block group-focus-within:block whitespace-nowrap rounded-md px-2 py-1 text-[10.5px] leading-4 font-medium text-white bg-[#24292e] shadow-md ${i === weeks.length - 1 ? "right-0" : "left-0"}`}>
                    {tip}
                  </span>
                </span>
              );
            })}
          </div>
        ))}
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
