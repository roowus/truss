import { useEffect, useMemo, useRef, useState, Fragment } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { store, useApp, useNow, type Call, type SessionView } from "@/lib/store";
import { argSummary, fmtCost, fmtMs, fmtTokens, harnessStyle } from "@/lib/format";
import { harnessDisplay, hostAliases } from "@/lib/device";
import { useDesktops } from "@/lib/desktops";
import { trajectoryTimeline, timelineOverview, matchTurns, type TimelineOverview, type TimelineTurn } from "@/lib/trajectoryTimeline";
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
  const ov = useMemo(() => timelineOverview(turns, now), [turns, now]);
  const [zoom, setZoom] = useState<{ start: number; end: number } | null>(null);
  const [query, setQuery] = useState("");
  const [flash, setFlash] = useState<number | null>(null);
  const feedRef = useRef<HTMLDivElement | null>(null);

  // a zoom window that no longer intersects the data (rehydrate, new session) resets itself
  useEffect(() => {
    if (ov && zoom && (zoom.end < ov.start || zoom.start > ov.end)) setZoom(null);
  }, [ov, zoom]);

  const matched = useMemo(() => matchTurns(turns, query), [turns, query]);
  const searching = query.trim().length > 0;

  const shown = useMemo(() => {
    const inWindow = (i: number) =>
      !zoom || !ov || ov.spans.some((s) => s.turnIndex === i && s.end >= zoom.start && s.start <= zoom.end);
    return turns.map((t, i) => ({ t, i })).filter(({ i }) => matched[i] && inWindow(i));
  }, [turns, matched, ov, zoom]);

  /* click-to-jump on the overview. A turn filtered out (zoom or search) is
     not rendered, so the filters clear first and the jump runs after the
     feed re-renders — otherwise the click silently does nothing (audit B1) */
  const pendingFocus = useRef<number | null>(null);
  const doFocus = (i: number) => {
    feedRef.current?.querySelector(`[data-turn="${i}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setFlash(i);
    window.setTimeout(() => setFlash((f) => (f === i ? null : f)), 1200);
  };
  const focusTurn = (i: number) => {
    if (!shown.some((s) => s.i === i)) {
      pendingFocus.current = i;
      if (zoom) setZoom(null);
      if (searching) setQuery("");
      return;
    }
    doFocus(i);
  };
  useEffect(() => {
    if (pendingFocus.current != null && shown.some((s) => s.i === pendingFocus.current)) {
      const i = pendingFocus.current;
      pendingFocus.current = null;
      doFocus(i);
    }
  }, [zoom, query, shown]);

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
    <>
      {ov && (
        <OverviewStrip
          ov={ov}
          zoom={zoom}
          zoomCount={shown.length}
          matched={matched}
          searching={searching}
          query={query}
          onQuery={setQuery}
          onZoom={setZoom}
          onFocus={focusTurn}
        />
      )}
      <div ref={feedRef} className="flex-1 min-h-0 overflow-auto t-scroll">
        <div className="px-3 py-2 space-y-1.5 min-w-[420px]">
          {shown.length === 0 ? (
            <div className="py-8 text-center text-[11.5px] text-[var(--t-dim)]">
              {searching ? "No turns match." : "No turns in the zoomed window."}
            </div>
          ) : (
            shown.map(({ t, i }, n) => (
              <div key={`${t.at}-${i}`} data-turn={i}>
                <TurnRow turn={t} now={now} first={n === 0} flash={flash === i} />
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}

/* Chrome-Network-style overview above the feed, layered like DSH's: three
   lanes (you / model / tools), each record its own span across the full
   session domain, color-coded per lane (sky / teal / violet; red on a failed
   tool, striped amber while in flight). Drag-select zooms the feed to a
   window; a click jumps the feed to the nearest turn; Escape or the reset
   link clears the zoom. The search box filters the feed to matching turns
   and dims everything else on the strip. */
const LANE_TOP = [4, 17, 30]; // px within the 42px track; spans are h-2
/* Lane hues follow DSH's contrast scheme (developer feedback): vivid blue
   for you, vivid violet for the model, vivid yellow for tools — hue
   opposites, no two adjacent. Red alone signals failure; in-flight keeps
   its lane color and shows the animated stripes (t-stripes is an overlay,
   so it composes). Deliberately not the theme's pastel accents. */
const LANE_COLOR = ["#3b9eff", "#b26bff", "#ffd60a"] as const;
const LANE_LABEL = ["you", "model", "tools"] as const;
const VIVID_FAIL = "#ff4545";

function OverviewStrip({ ov, zoom, zoomCount, matched, searching, query, onQuery, onZoom, onFocus }: {
  ov: TimelineOverview;
  zoom: { start: number; end: number } | null;
  /** turns rendered under the active filters (the feed's own count, not a recompute) */
  zoomCount: number;
  /** one flag per turn from matchTurns */
  matched: boolean[];
  searching: boolean;
  query: string;
  onQuery: (q: string) => void;
  onZoom: (z: { start: number; end: number } | null) => void;
  onFocus: (turnIndex: number) => void;
}) {
  const [draft, setDraft] = useState<[number, number] | null>(null);
  const anchor = useRef<number | null>(null);
  const span = ov.end - ov.start;
  const pct = (t: number) => Math.min(100, Math.max(0, ((t - ov.start) / span) * 100));
  const timeAt = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return ov.start + Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width))) * span;
  };
  const sel = draft ? { start: Math.min(draft[0], draft[1]), end: Math.max(draft[0], draft[1]) } : zoom;
  const cancelDrag = () => {
    anchor.current = null;
    setDraft(null);
  };
  const turnCount = matched.length;

  return (
    <div className="shrink-0 px-3 pt-2 pb-1.5 border-b border-[var(--t-line)]">
      {/* search (the lane legend is the gutter beside the track) */}
      <div className="flex items-center gap-3 mb-1.5">
        <div className="relative">
          <Icon name="search" size={11} className="absolute left-1.5 top-1/2 -translate-y-1/2 text-[var(--t-dim)]" />
          <input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && searching) onQuery("");
            }}
            placeholder="search turns"
            aria-label="Search turns"
            className="h-6 w-44 pl-6 pr-2 rounded border border-[var(--t-line)] bg-[var(--t-bg0)] text-[11px] text-[var(--t-fg)] placeholder:text-[var(--t-dim)] outline-none focus:border-[var(--t-sky)]"
          />
        </div>
        {searching && (
          <span className="font-mono text-[10px] text-[var(--t-sky)] tabular-nums">
            {matched.filter(Boolean).length} of {turnCount} turns
          </span>
        )}
      </div>

      {/* the three-lane track, with the legend as a left gutter whose rows
          align with the lanes they name */}
      <div className="flex items-stretch gap-1.5">
        <div className="relative w-9 shrink-0" aria-hidden>
          {LANE_LABEL.map((label, lane) => (
            <span
              key={label}
              className="absolute right-0 font-mono text-[9px] uppercase tracking-wider -translate-y-1/2"
              style={{ top: LANE_TOP[lane] + 4, color: LANE_COLOR[lane] }}
            >
              {label}
            </span>
          ))}
        </div>
        <div
          className="relative h-[42px] flex-1 rounded border border-[var(--t-line)] bg-[var(--t-bg0)] overflow-hidden cursor-crosshair select-none touch-none outline-none focus-visible:ring-1 focus-visible:ring-[var(--t-sky)]"
          role="group"
          tabIndex={0}
          aria-label={`Session overview timeline, ${zoom ? `zoomed to ${fmtMs(zoom.end - zoom.start)} of ${fmtMs(span)}` : `full span ${fmtMs(span)}`}`}
          onKeyDown={(e) => {
            if (e.key === "Escape") onZoom(null);
          }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            anchor.current = timeAt(e);
            setDraft(null);
          }}
          onPointerMove={(e) => {
            if (anchor.current != null) setDraft([anchor.current, timeAt(e)]);
          }}
          onPointerCancel={cancelDrag}
          onPointerUp={(e) => {
            if (anchor.current == null) return;
            const a = anchor.current;
            anchor.current = null;
            setDraft(null);
            const b = timeAt(e);
            const lo = Math.min(a, b), hi = Math.max(a, b);
            if (hi - lo < span * 0.02) {
              // a click: jump the feed to the nearest record's turn
              let best = 0, bestD = Infinity;
              for (const s of ov.spans) {
                const d = Math.min(Math.abs(s.start - b), Math.abs(s.end - b));
                if (d < bestD) { bestD = d; best = s.turnIndex; }
              }
              onFocus(best);
            } else {
              onZoom({ start: lo, end: hi });
            }
          }}
        >
          {/* lane separators */}
          {[13, 26].map((y) => (
            <span key={y} className="absolute left-0 right-0 h-px bg-[var(--t-line)]/40 pointer-events-none" style={{ top: y }} />
          ))}
          {ov.spans.map((s, n) => {
            const left = pct(s.start);
            const width = Math.max(0.5, pct(s.end) - left);
            const dim = searching && !matched[s.turnIndex];
            return (
              <span
                key={`${s.turnIndex}-${s.lane}-${n}`}
                className={cn("absolute h-2 rounded-[2px]", s.inFlight && "t-stripes")}
                style={{
                  top: LANE_TOP[s.lane],
                  left: `${left}%`,
                  width: `${Math.min(width, 100 - left)}%`,
                  background: s.failed ? VIVID_FAIL : LANE_COLOR[s.lane],
                  opacity: dim ? 0.15 : 0.85,
                  ...(searching && matched[s.turnIndex] ? { boxShadow: "0 0 0 1px var(--t-sky)" } : {}),
                }}
              />
            );
          })}
          {sel && (
            <span
              className="absolute inset-y-0 border-x border-[var(--t-sky)] bg-[color-mix(in_oklab,var(--t-sky)_14%,transparent)] pointer-events-none"
              style={{ left: `${pct(sel.start)}%`, width: `${Math.max(0.4, pct(sel.end) - pct(sel.start))}%` }}
            />
          )}
        </div>
      </div>
      <div className="flex items-center justify-between mt-1 font-mono text-[9.5px] text-[var(--t-dim)] tabular-nums">
        <span>{new Date(ov.start).toLocaleTimeString()}</span>
        {zoom ? (
          <button onClick={() => onZoom(null)} className="text-[var(--t-sky)] hover:underline">
            zoomed to {fmtMs(zoom.end - zoom.start)} ({zoomCount} turns) · reset
          </button>
        ) : (
          <span>{turnCount} turns · drag to zoom · click to jump</span>
        )}
        <span>{new Date(ov.end).toLocaleTimeString()} · {fmtMs(span)}</span>
      </div>
    </div>
  );
}

function TurnRow({ turn, now, first, flash }: { turn: TimelineTurn; now: number; first: boolean; flash?: boolean }) {
  const a = turn.assistant;
  const aOpen = !!a && a.doneAt === undefined;
  return (
    <div className={cn(
      "rounded-md border border-[var(--t-line)]/70 bg-[var(--t-bg2)]/40 transition-shadow",
      !first && "mt-2",
      flash && "ring-1 ring-[var(--t-sky)]",
    )}>
      {/* turn header: time + the user's message (lane-colored to match the overview strip) */}
      <div className="flex items-baseline gap-2 px-2.5 pt-2">
        <span className="shrink-0 font-mono text-[10px] text-[var(--t-dim)] tabular-nums">{new Date(turn.at).toLocaleTimeString()}</span>
        {turn.user ? (
          <span className="min-w-0 flex items-baseline gap-1.5 text-[12px] text-[var(--t-fg)]" title={turn.user.text}>
            <span className="inline-block w-1.5 h-1.5 rounded-[2px] shrink-0 self-center" style={{ background: LANE_COLOR[0] }} />
            <span className="line-clamp-2 break-words">{turn.user.text}</span>
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

      {/* assistant span (model lane color) */}
      {a && (
        <div className="flex items-center gap-2 px-2.5 py-1.5 font-mono text-[11.5px]">
          {aOpen ? <Spinner size={11} /> : <Icon name="wave" size={11} className="text-[#b26bff]" />}
          <span className="truncate text-[#b26bff]">{a.model ?? "assistant"}</span>
          <span className={cn("ml-auto shrink-0 tabular-nums", aOpen ? "text-[var(--t-fg2)] t-pulse" : "text-[var(--t-dim)]")}>
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
                  <Icon name={t.ok === false ? "x" : "check"} size={11} className={t.ok === false ? "text-[#ff4545]" : "text-[#ffd60a]"} />
                )}
                <span className={cn("truncate", t.ok === false ? "text-[#ff4545]" : "text-[#ffd60a]")}>{t.name}</span>
                <span className={cn("ml-auto shrink-0 tabular-nums", open ? "text-[var(--t-fg2)] t-pulse" : t.ok === false ? "text-[#ff4545]" : "text-[var(--t-dim)]")}>
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
