import { useEffect, useMemo, useRef, useState } from "react";
import { store, useApp, useNow } from "@/lib/store";
import { fmtCost, fmtTokens, harnessStyle, shortPath } from "@/lib/format";
import { openDailyDriver, openFreeShell, openPanel } from "@/lib/workspace";
import { HarnessMark, Icon, StateDot } from "./ui";
import { cn } from "@/utils/cn";

/* ================= Status bar ================= */
export function StatusBar({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  const conn = useApp((s) => s.conn);
  const mode = useApp((s) => s.backend?.mode);
  const canRestart = useApp((s) => !!s.backend?.simulateRestart);
  const order = useApp((s) => s.order);
  const sessions = useApp((s) => s.sessions);
  const focused = useApp((s) => s.focused);
  const fmeta = useApp((s) => (s.focused ? s.sessions[s.focused] : undefined));
  const fctx = useApp((s) => (s.focused ? s.views[s.focused]?.ctx : undefined));
  const totalCost = useApp((s) => {
    let c = 0;
    for (const v of Object.values(s.views)) for (const id of v.callOrder) c += v.calls[id].costUsd ?? 0;
    return c;
  });
  const focusedCost = useApp((s) => {
    const v = s.focused ? s.views[s.focused] : undefined;
    if (!v) return undefined;
    let c = 0, has = false;
    for (const id of v.callOrder) if (v.calls[id].costUsd !== undefined) { has = true; c += v.calls[id].costUsd!; }
    return has ? c : undefined;
  });
  const pendingTotal = useApp((s) => Object.values(s.views).reduce((n, v) => n + v.pending.length, 0));
  const running = useMemo(() => order.filter((i) => sessions[i]?.state === "running" || sessions[i]?.state === "spawning"), [order, sessions]);
  const [menu, setMenu] = useState<"running" | null>(null);
  const now = useNow(1000, conn.kind === "closed");

  const firstPending = () => {
    for (const [id, v] of Object.entries(store.state.views)) if (v.pending.length) return id;
  };

  return (
    <footer className="relative shrink-0 h-[26px] flex items-center gap-0 px-1 border-t border-[var(--t-line)] bg-[var(--t-bg0)] font-mono text-[10.5px] text-[var(--t-mute)] select-none">
      <SBItem onClick={onToggleSidebar} title="Toggle sidebar"><Icon name="layout" size={11} /></SBItem>
      <SBItem title={conn.kind === "open" ? "Event bus connected — all devices stay in sync" : "Event bus disconnected — reconnecting with backoff"}>
        <span className={cn("w-1.5 h-1.5 rounded-full", conn.kind === "open" ? "bg-[var(--t-teal)]" : conn.kind === "connecting" ? "bg-[var(--t-amber)] t-pulse" : "bg-[var(--t-red)] t-pulse")} />
        {conn.kind === "open" ? "live" : conn.kind === "connecting" ? "connecting…" : `offline · retry ${Math.max(0, Math.ceil((conn.retryAt - now) / 1000))}s`}
      </SBItem>
      {mode === "demo" && (
        <SBItem title="No Truss server detected — harnesses are simulated in-browser against the real contract">
          <span className="px-1 rounded bg-[color-mix(in_oklab,var(--t-violet)_18%,transparent)] text-[var(--t-violet)]">demo backend</span>
        </SBItem>
      )}
      <SBItem onClick={() => setMenu(menu ? null : "running")} title="Running agents">
        {running.length ? <StateDot state="running" size={7} /> : <Icon name="bolt" size={11} />}
        <span className={running.length ? "text-[var(--t-amber)]" : ""}>{running.length} running</span>
      </SBItem>
      {pendingTotal > 0 && (
        <SBItem onClick={() => { const id = firstPending(); if (id) openPanel("chat", { sessionId: id }); }} title="Permission requests waiting">
          <span className="inline-flex items-center gap-1 px-1.5 rounded bg-[var(--t-amber)] text-[#1b1305] font-bold t-pulse-soft">
            <Icon name="lock" size={10} /> {pendingTotal} awaiting you
          </span>
        </SBItem>
      )}
      <div className="flex-1" />
      {fmeta && (
        <SBItem onClick={() => focused && openPanel("context", { sessionId: focused })} title="Focused session context">
          <HarnessMark harness={fmeta.harness} size={13} />
          <span className="max-w-[160px] truncate text-[var(--t-fg2)]">{fmeta.title}</span>
          {fctx ? (
            <span className="inline-flex items-center gap-1">
              <span className="w-12 h-1.5 rounded-full bg-[var(--t-line)] overflow-hidden">
                <span className="block h-full" style={{ width: `${Math.min(100, (fctx.used / fctx.total) * 100)}%`, background: fctx.used / fctx.total > 0.85 ? "var(--t-red)" : fctx.used / fctx.total > 0.6 ? "var(--t-amber)" : "var(--t-teal)" }} />
              </span>
              {fmtTokens(fctx.used)}/{fmtTokens(fctx.total)}
            </span>
          ) : (
            <span className="text-[var(--t-dim)]">ctx —</span>
          )}
          <span>· {fmtCost(focusedCost)}</span>
        </SBItem>
      )}
      <SBItem title="Total reported cost across loaded sessions">Σ {fmtCost(totalCost)}</SBItem>
      {canRestart && (
        <SBItem onClick={() => store.state.backend?.simulateRestart?.()} title="Demo: kill all harness processes and drop the event bus, like `systemctl restart truss`">
          <Icon name="restart" size={11} /> simulate restart
        </SBItem>
      )}

      {menu === "running" && (
        <Popover onClose={() => setMenu(null)}>
          <div className="px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-[var(--t-dim)]">running agents</div>
          {running.length === 0 && <div className="px-2.5 pb-2 text-[11.5px] text-[var(--t-dim)] font-sans">Nothing running.</div>}
          {running.map((id) => {
            const s = sessions[id];
            return (
              <button key={id} onClick={() => { openPanel("chat", { sessionId: id }); setMenu(null); }} className="w-full flex items-center gap-2 px-2.5 h-8 hover:bg-white/5 text-left">
                <HarnessMark harness={s.harness} size={16} />
                <span className="flex-1 truncate font-sans text-[12px] text-[var(--t-fg)]">{s.title}</span>
                <StateDot state={s.state} size={7} />
              </button>
            );
          })}
        </Popover>
      )}
    </footer>
  );
}

function SBItem({ children, onClick, title }: { children: React.ReactNode; onClick?: () => void; title?: string }) {
  const C: any = onClick ? "button" : "div";
  return (
    <C onClick={onClick} title={title} className={cn("h-full inline-flex items-center gap-1.5 px-2", onClick && "hover:bg-white/[0.05] hover:text-[var(--t-fg)]")}>
      {children}
    </C>
  );
}

function Popover({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute bottom-[30px] left-24 z-50 w-72 rounded-lg bg-[var(--t-bg2)] border border-[var(--t-line2)] shadow-2xl py-1 t-pop">{children}</div>
    </>
  );
}

/* ================= Toasts ================= */
export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="fixed right-3 bottom-9 z-[200] flex flex-col gap-2 w-[340px] max-w-[calc(100vw-24px)] pointer-events-none" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} role={t.kind === "error" ? "alert" : "status"} className="pointer-events-auto rounded-lg bg-[var(--t-bg2)] border border-[var(--t-line2)] shadow-2xl px-3 py-2.5 flex gap-2.5 t-pop" style={{ borderLeft: `3px solid ${t.kind === "error" ? "var(--t-red)" : t.kind === "ok" ? "var(--t-teal)" : "var(--t-sky)"}` }}>
          <Icon name={t.kind === "error" ? "alert" : t.kind === "ok" ? "check" : "bolt"} size={14} className={cn("mt-0.5", t.kind === "error" ? "text-[var(--t-red)]" : t.kind === "ok" ? "text-[var(--t-teal)]" : "text-[var(--t-sky)]")} />
          <div className="flex-1 min-w-0">
            <div className="text-[12.5px] text-[var(--t-fg)] font-medium">{t.title}</div>
            {t.body && <div className="mt-0.5 text-[11.5px] text-[var(--t-mute)] break-words font-mono">{t.body}</div>}
          </div>
          <button onClick={() => store.dismiss(t.id)} className="self-start text-[var(--t-dim)] hover:text-[var(--t-fg)]"><Icon name="x" size={12} /></button>
        </div>
      ))}
    </div>
  );
}

/* ================= Command palette ================= */
type Cmd = { id: string; label: string; hint?: string; icon?: string; harness?: string; run: () => void };

export function CommandPalette({ onClose, onNew }: { onClose: () => void; onNew: () => void }) {
  const order = useApp((s) => s.order);
  const sessions = useApp((s) => s.sessions);
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const cmds: Cmd[] = useMemo(() => {
    const base: Cmd[] = [
      { id: "new", label: "New session…", icon: "plus", hint: "N", run: onNew },
      { id: "shell", label: "New free shell", icon: "term", run: () => openFreeShell() },
      { id: "welcome", label: "Open welcome", icon: "layout", run: () => openPanel("welcome") },
    ];
    const ss: Cmd[] = order.flatMap((id) => {
      const s = sessions[id];
      if (!s) return [];
      return [
        { id: "c" + id, label: s.title, hint: `${s.harness} · ${shortPath(s.cwd)}`, harness: s.harness, run: () => openPanel("chat", { sessionId: id }) },
        { id: "d" + id, label: `${s.title} — chat + trajectory + context`, hint: "daily driver", icon: "layout", run: () => openDailyDriver(id) },
        { id: "t" + id, label: `${s.title} — trajectory`, icon: "wave", run: () => openPanel("trajectory", { sessionId: id }) },
      ];
    });
    return [...base, ...ss];
  }, [order, sessions, onNew]);
  const list = cmds.filter((c) => !q || (c.label + " " + (c.hint ?? "")).toLowerCase().includes(q.toLowerCase())).slice(0, 40);
  useEffect(() => setI(0), [q]);

  const run = (c?: Cmd) => {
    if (!c) return;
    onClose();
    c.run();
  };
  return (
    <div className="fixed inset-0 z-[150] bg-black/50 grid justify-items-center items-start pt-[12vh] px-4 t-fade" onMouseDown={onClose}>
      <div className="w-full max-w-[560px] rounded-xl bg-[var(--t-bg1)] border border-[var(--t-line2)] shadow-2xl overflow-hidden t-pop" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-4 h-12 border-b border-[var(--t-line)]">
          <Icon name="search" size={14} className="text-[var(--t-dim)]" />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setI((x) => Math.min(list.length - 1, x + 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setI((x) => Math.max(0, x - 1)); }
              else if (e.key === "Enter") run(list[i]);
              else if (e.key === "Escape") onClose();
            }}
            placeholder="Jump to a session or run a command…"
            className="flex-1 bg-transparent outline-none text-[14px] text-[var(--t-fg)] placeholder:text-[var(--t-dim)]"
          />
        </div>
        <div className="max-h-[50vh] overflow-auto t-scroll py-1">
          {list.length === 0 && <div className="px-4 py-6 text-center text-[12px] text-[var(--t-dim)]">No matches.</div>}
          {list.map((c, idx) => (
            <button key={c.id} onMouseEnter={() => setI(idx)} onClick={() => run(c)} className={cn("w-full flex items-center gap-2.5 px-4 h-9 text-left", idx === i && "bg-white/[0.05]")}>
              {c.harness ? <HarnessMark harness={c.harness} size={18} /> : <span className="w-[18px] grid place-items-center text-[var(--t-mute)]"><Icon name={c.icon ?? "chev"} size={13} /></span>}
              <span className="flex-1 truncate text-[13px] text-[var(--t-fg)]">{c.label}</span>
              {c.hint && <span className="font-mono text-[10.5px] text-[var(--t-dim)] truncate max-w-[220px]" style={c.harness ? { color: harnessStyle(c.harness).color } : undefined}>{c.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
