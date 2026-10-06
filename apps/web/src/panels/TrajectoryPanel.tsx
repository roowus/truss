import { useEffect, useMemo, useState, Fragment } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { store, useApp, useNow, type Call, type SessionView } from "@/lib/store";
import { argSummary, fmtCost, fmtMs, fmtTokens, harnessStyle } from "@/lib/format";
import { harnessDisplay, hostAliases } from "@/lib/device";
import { useDesktops } from "@/lib/desktops";
import { trajectoryTimeline, type TimelineTurn } from "@/lib/trajectoryTimeline";
import { Empty, HarnessMark, Icon, Spinner } from "@/components/ui";
import { cn } from "@/utils/cn";

type P = { sessionId: string };
const isErr = (c: Call) => c.done && c.status != null && (c.status < 200 || c.status >= 300);
const COLS = "grid-cols-[34px_22px_minmax(90px,1.2fr)_48px_62px_64px_54px_54px_62px_minmax(120px,2fr)]";

/* The timeline is a pure projection of the event log (issue #142). The
   store keeps the reduced view, so the panel re-synthesizes flat events
   from it and runs the same tested projection the spec pins — one code
   path, exercised by apps/web/test/trajectoryTimeline.test.ts. */
function viewEvents(view: SessionView): { type: string; at?: number; [k: string]: unknown }[] {
  const evs: { type: string; at?: number; [k: string]: unknown }[] = [];
  for (const m of Object.values(view.msgs)) {
    evs.push({ type: "msg.start", at: m.at, messageId: m.id, role: m.role });
    const text = m.segments.filter((s) => s.channel !== "thinking").map((s) => s.text).join("");
    if (text) evs.push({ type: "msg.chunk", at: m.at, messageId: m.id, text });
    if (m.done) evs.push({ type: "msg.done", at: m.doneAt ?? m.at, messageId: m.id });
  }
  for (const t of Object.values(view.tools)) {
    evs.push({ type: "tool.start", at: t.startedAt, callId: t.id, name: t.name });
    if (t.status !== "running") {
      evs.push({ type: "tool.done", at: t.durationMs != null ? t.startedAt + t.durationMs : t.startedAt, callId: t.id, ok: t.status === "ok" });
    }
  }
  for (const c of Object.values(view.calls)) {
    evs.push({ type: "llm.call.start", at: c.at, callId: c.callId, model: c.model });
    if (c.done) {
      evs.push({ type: "llm.call.done", at: c.at + (c.latencyMs ?? 0), callId: c.callId, status: c.status, tokensIn: c.tokensIn, tokensOut: c.tokensOut });
    }
  }
  return evs;
}

export function TrajectoryPanel({ params }: IDockviewPanelProps<P>) {
  const id = params.sessionId;
  const meta = useApp((s) => s.sessions[id]);
  const view = useApp((s) => s.views[id]);
  useEffect(() => {
    if (meta) void store.ensureHydrated(id);
  }, [id, !!meta]);

  if (!meta) return <Empty icon="wave" title="Session no longer exists" />;
  if (!view || view.hydration === "loading") return <div className="h-full grid place-items-center"><Spinner /></div>;
  if (view.hydration === "error") return <Empty icon="alert" title="Couldn't load trajectory">{view.hydrationError}</Empty>;
  return <Trajectory id={id} view={view} />;
}

function Trajectory({ id, view }: { id: string; view: SessionView }) {
  const meta = useApp((s) => s.sessions[id]);
  const hosts = useApp((s) => s.hosts);
  const hostPrefs = useDesktops((s) => s.hosts);
  const harnessName = harnessDisplay(meta.harness, hosts, hostAliases(hostPrefs));
  const [tab, setTab] = useState<"timeline" | "calls">("timeline");
  const calls = useMemo(() => view.callOrder.map((c) => view.calls[c]), [view.callOrder, view.calls]);

  const stats = useMemo(() => {
    let lat = 0, tin = 0, tout = 0, cost = 0, hasTok = false, hasCost = false, errs = 0, retries = 0;
    for (const c of calls) {
      if (c.latencyMs) lat += c.latencyMs;
      if (c.tokensIn !== undefined || c.tokensOut !== undefined) hasTok = true;
      tin += c.tokensIn ?? 0;
      tout += c.tokensOut ?? 0;
      if (c.costUsd !== undefined) { hasCost = true; cost += c.costUsd; }
      if (isErr(c)) errs++;
      if (c.retryOf) retries++;
    }
    return { lat, tin, tout, cost, hasTok, hasCost, errs, retries };
  }, [calls]);

  return (
    <div className="h-full flex flex-col bg-[var(--t-bg1)] t-panel">
      {/* summary strip */}
      <div className="shrink-0 flex items-center gap-4 px-3 h-11 border-b border-[var(--t-line)] overflow-x-auto t-scroll-x">
        <div className="flex items-center gap-2 shrink-0">
          <HarnessMark harness={meta.harness} size={18} />
          <span className="text-[12px] text-[var(--t-fg)] font-medium truncate max-w-[180px]">{meta.title}</span>
        </div>
        <Stat label="calls" value={String(calls.length)} />
        <Stat label="errors" value={String(stats.errs)} tone={stats.errs ? "red" : undefined} />
        <Stat label="retries" value={String(stats.retries)} tone={stats.retries ? "amber" : undefined} />
        <Stat label="Σ latency" value={fmtMs(stats.lat)} />
        <Stat label="tokens in/out" value={stats.hasTok ? `${fmtTokens(stats.tin)} / ${fmtTokens(stats.tout)}` : "—"} title={stats.hasTok ? undefined : `${harnessName} reports tokens per turn, not per call`} />
        <Stat label="cost" value={stats.hasCost ? fmtCost(stats.cost) : "—"} />
        <div className="ml-auto flex items-center gap-0.5 shrink-0 p-0.5 rounded-md bg-[var(--t-bg0)] border border-[var(--t-line)]">
          {(["timeline", "calls"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={cn("h-6 px-2 rounded text-[11px] font-mono", tab === t ? "bg-[var(--t-bg3)] text-[var(--t-fg)]" : "text-[var(--t-mute)] hover:text-[var(--t-fg)]")}>
              {t}
            </button>
          ))}
        </div>
      </div>

      {tab === "timeline" ? (
        <TimelineView view={view} hasCalls={calls.length > 0} />
      ) : (
        <CallsView view={view} calls={calls} harness={meta.harness} harnessName={harnessName} />
      )}
    </div>
  );
}

/* ---------------- timeline (primary, issue #142) ---------------- */

function TimelineView({ view, hasCalls }: { view: SessionView; hasCalls: boolean }) {
  const turns = useMemo(() => trajectoryTimeline(viewEvents(view)), [view]);
  const anyOpen = turns.some((t) => (t.assistant && t.assistant.doneAt === undefined) || t.tools.some((x) => x.doneAt === undefined));
  const now = useNow(500, anyOpen);

  if (turns.length === 0) {
    return (
      <Empty icon="wave" title="Nothing on the timeline yet">
        {hasCalls
          ? "This session reported LLM calls but no messages or tools. The raw calls are in the calls view."
          : "Once the session gets going, each turn lands here: your message, the model's answer, and the tools it ran, with real durations."}
      </Empty>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-auto t-scroll">
      <div className="px-3 py-2 space-y-1.5 min-w-[420px]">
        {turns.map((t, i) => (
          <TurnRow key={`${t.at}-${i}`} turn={t} now={now} first={i === 0} />
        ))}
      </div>
    </div>
  );
}

function TurnRow({ turn, now, first }: { turn: TimelineTurn; now: number; first: boolean }) {
  const a = turn.assistant;
  const aOpen = !!a && a.doneAt === undefined;
  return (
    <div className={cn("rounded-md border border-[var(--t-line)]/70 bg-[var(--t-bg2)]/40", !first && "mt-2")}>
      {/* turn header: time + the user's message */}
      <div className="flex items-baseline gap-2 px-2.5 pt-2">
        <span className="shrink-0 font-mono text-[10px] text-[var(--t-dim)] tabular-nums">{new Date(turn.at).toLocaleTimeString()}</span>
        {turn.user ? (
          <span className="min-w-0 text-[12px] text-[var(--t-fg)] line-clamp-2 break-words" title={turn.user.text}>
            {turn.user.text}
          </span>
        ) : (
          <span className="text-[11px] italic text-[var(--t-dim)]">{a ? "assistant" : "tools"} · no user message in this part of the log</span>
        )}
        {(turn.tokensIn !== undefined || turn.tokensOut !== undefined) && (
          <span className="ml-auto shrink-0 font-mono text-[10px] text-[var(--t-mute)] tabular-nums" title="tokens this turn (in / out)">
            {fmtTokens(turn.tokensIn)} in · {fmtTokens(turn.tokensOut)} out
          </span>
        )}
      </div>

      {/* assistant span */}
      {a && (
        <div className="flex items-center gap-2 px-2.5 py-1.5 font-mono text-[11.5px]">
          {aOpen ? <Spinner size={11} /> : <Icon name="wave" size={11} className="text-[var(--t-teal)]" />}
          <span className="text-[var(--t-fg2)] truncate">{a.model ?? "assistant"}</span>
          <span className={cn("ml-auto shrink-0 tabular-nums", aOpen ? "text-[var(--t-amber)]" : "text-[var(--t-dim)]")}>
            {aOpen ? `${fmtMs(now - a.at)}…` : fmtMs(a.durationMs)}
          </span>
        </div>
      )}

      {/* tools inline, chronological */}
      {turn.tools.length > 0 && (
        <div className={cn("px-2.5 pb-2", a && "pt-0.5", "space-y-0.5")}>
          {turn.tools.map((t, i) => {
            const open = t.doneAt === undefined;
            return (
              <div key={`${t.at}-${i}`} className="flex items-center gap-2 pl-4 font-mono text-[11.5px] h-6">
                {open ? (
                  <Spinner size={10} />
                ) : (
                  <Icon name={t.ok === false ? "x" : "check"} size={11} className={t.ok === false ? "text-[var(--t-red)]" : "text-[var(--t-teal)]"} />
                )}
                <span className="text-[var(--t-fg2)] truncate">{t.name}</span>
                <span className={cn("ml-auto shrink-0 tabular-nums", open ? "text-[var(--t-amber)]" : t.ok === false ? "text-[var(--t-red)]" : "text-[var(--t-dim)]")}>
                  {open ? `${fmtMs(now - t.at)}…` : fmtMs(t.durationMs)}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {!a && turn.tools.length === 0 && <div className="px-2.5 pb-2" />}
    </div>
  );
}

/* ---------------- calls table (the #20 view, secondary) ---------------- */

function CallsView({ view, calls, harness, harnessName }: { view: SessionView; calls: Call[]; harness: string; harnessName: string }) {
  const [filter, setFilter] = useState<"all" | "errors" | "retries">("all");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const anyOpen = calls.some((c) => !c.done);
  const now = useNow(250, anyOpen);

  const t0 = calls[0]?.at ?? now;
  const tEnd = Math.max(t0 + 1000, ...calls.map((c) => (c.done ? c.at + (c.latencyMs ?? 0) : now)));
  const span = tEnd - t0;
  const byId = view.calls;
  const shown = calls.filter((c) => (filter === "errors" ? isErr(c) : filter === "retries" ? !!c.retryOf || calls.some((x) => x.retryOf === c.callId) : true));
  const h = harnessStyle(harness);

  return (
    <>
      <div className="shrink-0 flex items-center gap-2 px-3 h-8 border-b border-[var(--t-line)]">
        <span className="text-[10.5px] text-[var(--t-dim)]">raw LLM calls</span>
        <div className="ml-auto flex items-center gap-0.5 shrink-0 p-0.5 rounded-md bg-[var(--t-bg0)] border border-[var(--t-line)]">
          {(["all", "errors", "retries"] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)} className={cn("h-6 px-2 rounded text-[11px] font-mono", filter === f ? "bg-[var(--t-bg3)] text-[var(--t-fg)]" : "text-[var(--t-mute)] hover:text-[var(--t-fg)]")}>
              {f}
            </button>
          ))}
        </div>
      </div>
      {calls.length === 0 ? (
        <Empty icon="wave" title="No LLM calls yet">Every model request this session makes appears here as a row — latency, tokens, cost, and the tools it triggered.</Empty>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto t-scroll">
          <div className="min-w-[760px]">
            <div className={cn("sticky top-0 z-10 grid items-center gap-2 px-3 h-7 bg-[var(--t-bg2)] border-b border-[var(--t-line)] font-mono text-[10px] uppercase tracking-wider text-[var(--t-dim)]", COLS)}>
              <span>#</span><span /><span>model</span><span className="text-right">tools</span><span className="text-right">start</span><span className="text-right">latency</span><span className="text-right">in</span><span className="text-right">out</span><span className="text-right">cost</span>
              <span className="flex justify-between"><span>waterfall</span><span>{fmtMs(span)}</span></span>
            </div>
            {shown.map((c) => {
              const err = isErr(c);
              const lat = c.done ? c.latencyMs ?? 0 : now - c.at;
              const left = ((c.at - t0) / span) * 100;
              const width = Math.max(0.6, (lat / span) * 100);
              const isOpen = !!open[c.callId];
              const retried = calls.find((x) => x.retryOf === c.callId);
              return (
                <Fragment key={c.callId}>
                  <button
                    onClick={() => setOpen((o) => ({ ...o, [c.callId]: !o[c.callId] }))}
                    className={cn(
                      "w-full grid items-center gap-2 px-3 h-8 text-left border-b border-[var(--t-line)]/60 font-mono text-[11.5px] hover:bg-white/[0.025]",
                      COLS,
                      err && "bg-[color-mix(in_oklab,var(--t-red)_7%,transparent)]",
                      isOpen && "bg-white/[0.03]",
                    )}
                    title={c.status ? `status: ${c.status}` : "in flight"}
                  >
                    <span className="text-[var(--t-dim)] tabular-nums flex items-center gap-1">
                      <Icon name="chev" size={9} className={cn("transition-transform", isOpen && "rotate-90")} />
                      {c.index}
                    </span>
                    <span>{!c.done ? <Spinner size={11} /> : err ? <Icon name="x" size={12} className="text-[var(--t-red)]" /> : <Icon name="check" size={12} className="text-[var(--t-teal)]" />}</span>
                    <span className="truncate flex items-center gap-1.5 min-w-0">
                      {c.retryOf && (
                        <span className="shrink-0 inline-flex items-center gap-0.5 px-1 rounded text-[10px] text-[var(--t-amber)] bg-[color-mix(in_oklab,var(--t-amber)_12%,transparent)]" title={`retry of call #${byId[c.retryOf]?.index ?? "?"}`}>
                          <Icon name="retry" size={9} />#{byId[c.retryOf]?.index ?? "?"}
                        </span>
                      )}
                      <span className={cn("truncate", err ? "text-[var(--t-red)]" : "text-[var(--t-fg2)]")}>{err ? c.status : c.model}</span>
                      {retried && <span className="shrink-0 text-[10px] text-[var(--t-dim)]">→ retried #{retried.index}</span>}
                    </span>
                    <span className="text-right text-[var(--t-mute)] tabular-nums">{c.tools.length || "·"}</span>
                    <span className="text-right text-[var(--t-dim)] tabular-nums">+{fmtMs(c.at - t0)}</span>
                    <span className={cn("text-right tabular-nums", !c.done ? "text-[var(--t-amber)]" : lat > 8000 ? "text-[var(--t-amber)]" : "text-[var(--t-fg2)]")}>{fmtMs(lat)}</span>
                    <span className={cn("text-right tabular-nums", c.tokensIn === undefined ? "text-[var(--t-dim)]" : "text-[var(--t-fg2)]")}>{fmtTokens(c.tokensIn)}</span>
                    <span className={cn("text-right tabular-nums", c.tokensOut === undefined ? "text-[var(--t-dim)]" : "text-[var(--t-fg2)]")}>{fmtTokens(c.tokensOut)}</span>
                    <span className={cn("text-right tabular-nums", c.costUsd === undefined ? "text-[var(--t-dim)]" : "text-[var(--t-fg2)]")}>{fmtCost(c.costUsd)}</span>
                    <span className="relative h-3.5">
                      <span className="absolute inset-y-[6px] left-0 right-0 bg-[var(--t-line)]/50 rounded" />
                      <span
                        className={cn("absolute inset-y-0.5 rounded-[3px]", !c.done && "t-stripes")}
                        style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%`, background: err ? "var(--t-red)" : !c.done ? "var(--t-amber)" : h.color, opacity: err ? 0.85 : 0.75 }}
                      />
                    </span>
                  </button>
                  {isOpen && <CallDetail view={view} call={c} />}
                </Fragment>
              );
            })}
          </div>
        </div>
      )}
      {calls.length > 0 && calls.every((c) => c.tokensIn === undefined && c.tokensOut === undefined) && (
        <div className="shrink-0 px-3 py-1.5 border-t border-[var(--t-line)] text-[11px] text-[var(--t-dim)]">
          <span className="font-mono">—</span> = not reported. {harnessName} emits token counts per turn, not per call; Truss shows the absence instead of inventing zeros.
        </div>
      )}
    </>
  );
}

function CallDetail({ view, call }: { view: SessionView; call: Call }) {
  const tools = call.tools.map((t) => view.tools[t]).filter(Boolean);
  return (
    <div className="px-3 py-2 pl-[52px] bg-[var(--t-bg0)]/70 border-b border-[var(--t-line)] font-mono text-[11.5px]">
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-[10.5px] text-[var(--t-dim)] mb-2">
        <span>callId <span className="text-[var(--t-mute)]">{call.callId}</span></span>
        <span>at <span className="text-[var(--t-mute)]">{new Date(call.at).toLocaleTimeString()}</span></span>
        <span>status <span className={isErr(call) ? "text-[var(--t-red)]" : "text-[var(--t-mute)]"}>{call.status ?? "in flight"}</span></span>
        <span>model <span className="text-[var(--t-mute)]">{call.model}</span></span>
      </div>
      {tools.length === 0 ? (
        <div className="text-[var(--t-dim)] italic">no tools ran inside this call</div>
      ) : (
        <div className="space-y-0.5">
          {tools.map((t) => (
            <div key={t.id} className="grid grid-cols-[16px_minmax(80px,auto)_1fr_70px] gap-2 items-center h-6">
              {t.status === "running" ? <Spinner size={10} /> : <Icon name={t.status === "ok" ? "check" : "x"} size={11} className={t.status === "ok" ? "text-[var(--t-teal)]" : "text-[var(--t-red)]"} />}
              <span className="text-[var(--t-fg2)]">{t.name}</span>
              <span className="truncate text-[var(--t-mute)]">{argSummary(t.args)}</span>
              <span className="text-right text-[var(--t-dim)] tabular-nums">{fmtMs(t.durationMs)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone, title }: { label: string; value: string; tone?: "red" | "amber"; title?: string }) {
  return (
    <div className="shrink-0 leading-tight" title={title}>
      <div className="font-mono text-[9.5px] uppercase tracking-wider text-[var(--t-dim)]">{label}</div>
      <div className={cn("font-mono text-[12px] tabular-nums", tone === "red" ? "text-[var(--t-red)]" : tone === "amber" ? "text-[var(--t-amber)]" : "text-[var(--t-fg)]")}>{value}</div>
    </div>
  );
}
