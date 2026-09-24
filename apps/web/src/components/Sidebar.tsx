import { useMemo, useState, useEffect, type ReactNode } from "react";
import { store, useApp, useNow } from "@/lib/store";
import { ago, harnessStyle, shortPath, baseHarness } from "@/lib/format";
import { openAgentShell, openDailyDriver, openFreeShell, openPanel, getDockApi } from "@/lib/workspace";
import { HarnessMark, Icon, IconBtn, Kbd, StateDot, TrussLogo, Spinner, STATE_META } from "./ui";
import type { SessionMeta } from "@/lib/proto";
import { cn } from "@/utils/cn";

export function Sidebar({ onNew }: { onNew: () => void }) {
  const order = useApp((s) => s.order);
  const sessions = useApp((s) => s.sessions);
  const loaded = useApp((s) => s.sessionsLoaded);
  const err = useApp((s) => s.sessionsError);
  const terminals = useApp((s) => s.terminals);
  const agents = useApp((s) => s.agents);
  const [q, setQ] = useState("");
  const [hf, setHf] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const now = useNow(15_000);

  const harnessesPresent = useMemo(() => [...new Set(order.map((i) => baseHarness(sessions[i]?.harness ?? "")))].filter(Boolean), [order, sessions]);
  const groups = useMemo(() => {
    const g = new Map<string, SessionMeta[]>();
    for (const id of order) {
      const s = sessions[id];
      if (!s) continue;
      if (hf && baseHarness(s.harness) !== hf) continue;
      if (q && !(s.title + " " + s.cwd + " " + (s.project ?? "") + " " + s.harness).toLowerCase().includes(q.toLowerCase())) continue;
      const k = s.project || "";
      if (!g.has(k)) g.set(k, []);
      g.get(k)!.push(s);
    }
    return [...g.entries()].sort((a, b) => (a[0] === "" ? 1 : b[0] === "" ? -1 : a[0].localeCompare(b[0])));
  }, [order, sessions, q, hf]);

  return (
    <aside className="h-full flex flex-col bg-[var(--t-bg0)] border-r border-[var(--t-line)]">
      <div className="shrink-0 flex items-center gap-2 px-3 h-12">
        <span className="text-[var(--t-amber)]"><TrussLogo size={16} /></span>
        <span className="font-semibold tracking-tight text-[15px] text-[var(--t-fg)]">truss</span>
        <button onClick={onNew} className="ml-auto inline-flex items-center gap-1.5 h-7 pl-2 pr-1.5 rounded-md bg-[var(--t-amber)] text-[#1b1305] text-[12px] font-semibold hover:brightness-110" title="New session (N)">
          <Icon name="plus" size={12} /> New <span className="opacity-60 font-mono text-[10px] px-1 rounded bg-black/10">N</span>
        </button>
      </div>

      <div className="shrink-0 px-3 pb-2 space-y-2">
        <div className="flex items-center gap-2 h-8 px-2.5 rounded-md bg-[var(--t-bg1)] border border-[var(--t-line)] focus-within:border-[var(--t-line2)]">
          <Icon name="search" size={12} className="text-[var(--t-dim)]" />
          <input id="session-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter sessions" className="flex-1 min-w-0 bg-transparent text-[12.5px] outline-none text-[var(--t-fg)] placeholder:text-[var(--t-dim)]" />
          <Kbd>⌘K</Kbd>
        </div>
        {harnessesPresent.length > 1 && (
          <div className="flex flex-wrap gap-1">
            <Chip active={!hf} onClick={() => setHf(null)}>all</Chip>
            {harnessesPresent.map((h) => (
              <Chip key={h} active={hf === h} color={harnessStyle(h).color} onClick={() => setHf(hf === h ? null : h)}>
                {harnessStyle(h).glyph} {h}
              </Chip>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto t-scroll px-1.5 pb-3">
        {!loaded ? (
          <div className="py-8 grid place-items-center"><Spinner /></div>
        ) : err ? (
          <div className="mx-1.5 mt-2 rounded-md border border-[color-mix(in_oklab,var(--t-red)_35%,transparent)] bg-[color-mix(in_oklab,var(--t-red)_8%,transparent)] p-2.5 text-[11.5px] text-[var(--t-red)]">
            <div className="font-medium mb-1 flex items-center gap-1.5"><Icon name="alert" size={12} /> Couldn't list sessions</div>
            <div className="font-mono text-[10.5px] break-all opacity-90">{err}</div>
            <button className="mt-2 underline" onClick={() => store.refreshSessions()}>retry</button>
          </div>
        ) : groups.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px] text-[var(--t-dim)]">
            {order.length ? "No sessions match." : <>No sessions yet.<br /><button className="mt-2 underline text-[var(--t-mute)]" onClick={onNew}>Start one</button></>}
          </div>
        ) : (
          groups.map(([project, list]) => {
            const key = project || "__none";
            const isCol = collapsed[key];
            const running = list.filter((s) => s.state === "running").length;
            return (
              <div key={key} className="mb-1">
                <button onClick={() => setCollapsed((c) => ({ ...c, [key]: !c[key] }))} className="w-full flex items-center gap-1.5 px-2 h-7 text-[10.5px] font-mono uppercase tracking-wider text-[var(--t-dim)] hover:text-[var(--t-mute)]">
                  <Icon name="chev" size={10} className={cn("transition-transform", !isCol && "rotate-90")} />
                  <Icon name="folder" size={11} />
                  <span className="truncate">{project || "unfiled"}</span>
                  <span className="ml-auto tabular-nums">{running > 0 && <span className="text-[var(--t-amber)] mr-1.5">{running} running</span>}{list.length}</span>
                </button>
                {!isCol && list.map((s) => <SessionRow key={s.id} s={s} now={now} />)}
              </div>
            );
          })
        )}

        <Section title="shells" action={<IconBtn icon="plus" label="New free shell" onClick={() => openFreeShell()} className="w-6 h-6" />}>
          {terminals.length === 0 ? (
            <div className="px-3 py-1 text-[11px] text-[var(--t-dim)]">No shells running.</div>
          ) : (
            terminals.map((t) => (
              <div key={t.id} className="group flex items-center gap-2 mx-0.5 px-2 h-7 rounded-md hover:bg-white/[0.03] cursor-pointer" onClick={() => openPanel("terminal", { terminalId: t.id, title: t.title })}>
                <Icon name="term" size={12} className={t.alive === false ? "text-[var(--t-red)]" : "text-[var(--t-teal)]"} />
                <span className="text-[12px] text-[var(--t-fg2)] truncate">{t.title ?? t.id}</span>
                <span className="font-mono text-[10px] text-[var(--t-dim)] truncate">{t.cwd ? shortPath(t.cwd) : ""}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    const p = getDockApi()?.getPanel(`terminal:${t.id}`);
                    p?.api.close();
                    void store.deleteTerminal(t.id);
                  }}
                  className="ml-auto opacity-0 group-hover:opacity-70 hover:!opacity-100 text-[var(--t-mute)]"
                  title="Kill shell"
                >
                  <Icon name="x" size={11} />
                </button>
              </div>
            ))
          )}
        </Section>

        {agents.length > 0 && (
          <Section title="remote hosts">
            {agents.map((a) => (
              <div key={a.hostId} className="flex items-center gap-2 mx-0.5 px-2 h-7 text-[12px] text-[var(--t-fg2)]">
                <Icon name="host" size={12} className="text-[var(--t-sky)]" />
                <span className="truncate">{a.hostname}</span>
                <span className="ml-auto font-mono text-[10px] text-[var(--t-dim)] truncate">{a.adapters.join(" · ")}</span>
              </div>
            ))}
          </Section>
        )}
      </div>
    </aside>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="mt-3 pt-2 border-t border-[var(--t-line)]">
      <div className="flex items-center px-2 h-7 text-[10.5px] font-mono uppercase tracking-wider text-[var(--t-dim)]">
        {title}
        <span className="ml-auto">{action}</span>
      </div>
      {children}
    </div>
  );
}

function Chip({ active, color, onClick, children }: { active: boolean; color?: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn("h-5 px-1.5 rounded font-mono text-[10.5px] border transition-colors", active ? "border-[var(--t-line2)] bg-[var(--t-bg2)] text-[var(--t-fg)]" : "border-transparent text-[var(--t-dim)] hover:text-[var(--t-mute)]")}
      style={active && color ? { color } : undefined}
    >
      {children}
    </button>
  );
}

function SessionRow({ s, now }: { s: SessionMeta; now: number }) {
  const focused = useApp((st) => st.focused === s.id);
  const pending = useApp((st) => st.views[s.id]?.pending.length ?? 0);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(false), 3000);
    return () => clearTimeout(t);
  }, [confirm]);
  const dead = s.state === "closed" || s.state === "error";
  return (
    <div
      onClick={() => openPanel("chat", { sessionId: s.id })}
      onDoubleClick={() => openDailyDriver(s.id)}
      className={cn(
        "group relative mx-0.5 px-2 py-1.5 rounded-md cursor-pointer transition-colors",
        focused ? "bg-[var(--t-bg2)]" : "hover:bg-white/[0.03]",
      )}
      title={`${s.title}\n${s.harness} · ${s.cwd}\n${STATE_META[s.state]?.hint ?? s.state}\n(double-click: chat + trajectory + context)`}
    >
      {focused && <span className="absolute left-0 top-2 bottom-2 w-[2px] rounded-full bg-[var(--t-amber)]" />}
      <div className="flex items-center gap-2">
        <HarnessMark harness={s.harness} size={18} className={dead ? "opacity-50" : ""} />
        <span className={cn("flex-1 min-w-0 truncate text-[12.5px]", dead ? "text-[var(--t-mute)]" : "text-[var(--t-fg)]")}>{s.title}</span>
        {pending > 0 && (
          <span className="inline-flex items-center gap-0.5 h-4 px-1 rounded bg-[var(--t-amber)] text-[#1b1305] text-[9.5px] font-bold t-pulse-soft" title="Permission waiting">
            <Icon name="lock" size={9} />{pending}
          </span>
        )}
        <span className="group-hover:hidden flex items-center gap-1.5">
          <span className="font-mono text-[10px] text-[var(--t-dim)] tabular-nums">{ago(+new Date(s.updated_at) || Date.parse(String(s.updated_at)), now)}</span>
          <StateDot state={s.state} size={7} />
        </span>
        <span className="hidden group-hover:flex items-center -my-1" onClick={(e) => e.stopPropagation()}>
          <IconBtn icon="wave" label="Trajectory" className="w-6 h-6" onClick={() => openPanel("trajectory", { sessionId: s.id })} />
          <IconBtn icon="term" label="Shell in cwd" className="w-6 h-6" onClick={() => openAgentShell(s.id)} />
          {!dead && <IconBtn icon="power" label="Close (stop process, keep history)" className="w-6 h-6" onClick={() => store.closeSession(s.id)} />}
          <IconBtn
            icon="trash"
            label={confirm ? "Click again to delete history permanently" : "Delete session + history"}
            className={cn("w-6 h-6", confirm && "!text-[var(--t-red)] bg-[color-mix(in_oklab,var(--t-red)_15%,transparent)]")}
            onClick={() => (confirm ? store.deleteSession(s.id) : setConfirm(true))}
          />
        </span>
      </div>
      <div className="pl-[26px] mt-0.5 flex items-center gap-1.5 font-mono text-[10.5px] text-[var(--t-dim)] min-w-0">
        <span className="truncate">{shortPath(s.cwd)}</span>
        {s.model && <><span>·</span><span className="truncate">{s.model}</span></>}
        {confirm && <span className="ml-auto text-[var(--t-red)] shrink-0">delete?</span>}
      </div>
    </div>
  );
}
