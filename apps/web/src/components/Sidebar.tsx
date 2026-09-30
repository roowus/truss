import { useMemo, useState, useEffect, type ReactNode } from "react";
import { store, useApp, useNow } from "@/lib/store";
import { desktops, useDesktops } from "@/lib/desktops";
import { ago, shortPath } from "@/lib/format";
import { openAgentShell, openDailyDriver, openFreeShell, openPanel, openSession } from "@/lib/workspace";
import { HarnessMark, Icon, IconBtn, StateDot, TrussLogo, Spinner, STATE_META } from "./ui";
import type { SessionMeta } from "@/lib/proto";
import { cn } from "@/utils/cn";

export function Sidebar({ onNew }: { onNew: () => void }) {
  const order = useApp((s) => s.order);
  const sessions = useApp((s) => s.sessions);
  const loaded = useApp((s) => s.sessionsLoaded);
  const err = useApp((s) => s.sessionsError);
  const terminals = useApp((s) => s.terminals);
  const hosts = useApp((s) => s.hosts);
  const agentsError = useApp((s) => s.agentsError);
  const hostPrefs = useDesktops((s) => s.hosts);
  const groupMode = useDesktops((s) => s.settings.groupMode);
  const [q, setQ] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const now = useNow(15_000);

  /* group sessions by project tag, or by workspace folder (cwd);
     archived sessions leave the main list and collect below */
  const [groups, archived] = useMemo(() => {
    const g = new Map<string, SessionMeta[]>();
    const arch: SessionMeta[] = [];
    for (const id of order) {
      const s = sessions[id];
      if (!s) continue;
      if (q && !(s.title + " " + s.cwd + " " + (s.project ?? "") + " " + s.harness).toLowerCase().includes(q.toLowerCase())) continue;
      if (s.archived) {
        arch.push(s);
        continue;
      }
      const k = groupMode === "folder" ? shortPath(s.cwd) || s.cwd : s.project || "";
      if (!g.has(k)) g.set(k, []);
      g.get(k)!.push(s);
    }
    return [[...g.entries()].sort((a, b) => (a[0] === "" ? 1 : b[0] === "" ? -1 : a[0].localeCompare(b[0]))), arch] as const;
  }, [order, sessions, q, groupMode]);

  return (
    <aside className="h-full flex flex-col bg-[var(--t-bg0)] border-r border-[var(--t-line)]">
      <div className="shrink-0 flex items-center gap-2 px-3 h-12">
        <span className="text-[var(--t-amber)]"><TrussLogo size={15} /></span>
        <span className="font-semibold tracking-tight text-[14px] text-[var(--t-fg)]">truss</span>
        <IconBtn icon="plus" label="New session (N)" className="ml-auto" onClick={onNew} />
      </div>

      <div className="shrink-0 px-3 pb-2">
        <div className="flex items-center gap-2 h-8 px-2.5 rounded-md bg-[var(--t-bg1)] border border-[var(--t-line)] focus-within:border-[var(--t-line2)]">
          <Icon name="search" size={12} className="text-[var(--t-dim)]" />
          <input id="session-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className="flex-1 min-w-0 bg-transparent text-[12.5px] outline-none text-[var(--t-fg)] placeholder:text-[var(--t-dim)]" />
        </div>
        {/* group sessions by project tag or by workspace folder */}
        <div className="mt-1.5 flex items-center gap-1 px-0.5" role="group" aria-label="Group sessions by">
          {([["project", "tag", "Project"], ["folder", "folder", "Folder"]] as const).map(([mode, icon, label]) => (
            <button
              key={mode}
              onClick={() => desktops.updateSettings({ groupMode: mode })}
              title={`Group by ${label.toLowerCase()}`}
              aria-pressed={groupMode === mode}
              className={cn(
                "flex items-center gap-1 h-5 px-1.5 rounded text-[10px] font-medium uppercase tracking-[0.06em] transition-colors",
                groupMode === mode
                  ? "bg-[var(--t-bg3)] text-[var(--t-fg)]"
                  : "text-[var(--t-dim)] hover:text-[var(--t-mute)]",
              )}
            >
              <Icon name={icon} size={10} />
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto t-scroll px-1.5 pb-3">
        {!loaded ? (
          <div className="py-8 grid place-items-center"><Spinner /></div>
        ) : err ? (
          <div className="mx-1.5 mt-2 rounded-md border border-[color-mix(in_oklab,var(--t-red)_35%,transparent)] bg-[color-mix(in_oklab,var(--t-red)_8%,transparent)] p-2.5 text-[11.5px] text-[var(--t-red)]">
            <div className="font-medium mb-1 flex items-center gap-1.5"><Icon name="alert" size={12} /> Couldn't list sessions</div>
            <div className="text-[10.5px] break-all opacity-90">{err}</div>
            <button className="mt-2 underline" onClick={() => store.refreshSessions()}>retry</button>
          </div>
        ) : groups.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px] text-[var(--t-dim)]">
            {order.length ? "No matches." : <>No sessions yet.<br /><button className="mt-2 underline text-[var(--t-mute)]" onClick={onNew}>Start one</button></>}
          </div>
        ) : (
          groups.map(([project, list]) => {
            const key = project || "__none";
            const isCol = collapsed[key];
            const running = list.filter((s) => s.state === "running").length;
            const single = groups.length === 1 && !project;
            return (
              <div key={key} className="mb-1 group/grp">
                {!single && (
                  <div className="w-full flex items-center gap-1.5 px-2 h-7 text-[10.5px] font-medium uppercase tracking-[0.08em] text-[var(--t-dim)] hover:text-[var(--t-mute)]">
                    <button className="flex items-center gap-1.5 min-w-0 flex-1 text-left" onClick={() => setCollapsed((c) => ({ ...c, [key]: !c[key] }))}>
                      <Icon name="chev" size={9} className={cn("transition-transform", !isCol && "rotate-90")} />
                      <span className="truncate">{project || "unfiled"}</span>
                      {running > 0 && <span className="text-[var(--t-amber)]">{running}</span>}
                    </button>
                    {!!project && (
                      <span className="flex items-center gap-0.5 shrink-0">
                        {groupMode === "project" && (
                          <button
                            className="opacity-0 group-hover/grp:opacity-70 hover:!opacity-100"
                            title={`Archive the whole “${project}” project (${list.length} session${list.length === 1 ? "" : "s"}) — history kept`}
                            onClick={() => void store.archiveProject(project, true)}
                          >
                            <Icon name="archive" size={11} />
                          </button>
                        )}
                        {/* bulk trash the group's chats (issue #4) — two-click,
                            recoverable for 30 days; the folder itself is
                            never touched */}
                        <GroupTrash ids={list.map((x) => x.id)} name={project || "unfiled"} />
                      </span>
                    )}
                  </div>
                )}
                {!isCol && list.map((s) => <SessionRow key={s.id} s={s} now={now} />)}
              </div>
            );
          })
        )}

        {/* recently deleted (30-day trash) — restore or delete forever */}
        <TrashSection />

        {/* archived sessions collect here, collapsed by default */}
        {archived.length > 0 && (
          <div className="mt-2">
            <button
              className="w-full flex items-center gap-1.5 px-2 h-7 text-[10.5px] font-medium uppercase tracking-[0.08em] text-[var(--t-dim)] hover:text-[var(--t-mute)]"
              onClick={() => setCollapsed((c) => ({ ...c, __archived: !c.__archived }))}
            >
              <Icon name="chev" size={9} className={cn("transition-transform", collapsed.__archived && "rotate-90")} />
              <Icon name="archive" size={10} />
              <span>archived</span>
              <span className="ml-auto tabular-nums">{archived.length}</span>
            </button>
            {collapsed.__archived && archived.map((s) => <SessionRow key={s.id} s={s} now={now} archived />)}
          </div>
        )}

        <Section title="shells" action={<IconBtn icon="plus" label="New shell" onClick={() => openFreeShell()} className="w-6 h-6" />}>
          {terminals.length === 0 ? (
            <div className="px-3 py-1 text-[11px] text-[var(--t-dim)]">None running.</div>
          ) : (
            terminals.map((t) => (
              <div key={t.id} className="group flex items-center gap-2 mx-0.5 px-2 h-7 rounded-md hover:bg-white/[0.03] cursor-pointer" onClick={() => openPanel("terminal", { terminalId: t.id, title: t.title })} title={t.cwd ? shortPath(t.cwd) : undefined}>
                <Icon name="term" size={12} className={t.alive === false ? "text-[var(--t-red)]" : "text-[var(--t-dim)]"} />
                <span className="text-[12px] text-[var(--t-fg2)] truncate">{t.title ?? t.id}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void desktops.killTerminal(t.id);
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

        <Section title="remote hosts" action={<IconBtn icon="plus" label="Add host" className="w-5 h-5" onClick={() => window.dispatchEvent(new Event("truss:add-host"))} />}>
          {hosts.map((h) => (
            <button key={h.id} onClick={() => openPanel("host", { hostId: h.id, title: hostPrefs[h.id]?.alias || h.label })} className="group w-full flex items-center gap-2 mx-0.5 px-2 h-7 text-[12px] text-[var(--t-mute)] hover:text-[var(--t-fg)] hover:bg-white/[0.03] rounded-md text-left" title={`${h.label} · ${h.online ? `online · ${h.agent?.adapters.join(", ")}` : "offline"} · open host details`}>
              <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", h.online ? "bg-[var(--t-teal)]" : "bg-[var(--t-line2)]")} />
              <Icon name="host" size={12} className={h.online ? "text-[var(--t-sky)]" : "text-[var(--t-dim)]"} />
              <span className={cn("flex-1 truncate", !h.online && "opacity-50")}>{hostPrefs[h.id]?.alias || h.label}</span>
              {h.revoked && <span className="text-[8.5px] font-mono uppercase text-[var(--t-red)] shrink-0">revoked</span>}
              <Icon name="chev" size={10} className="opacity-0 group-hover:opacity-100 text-[var(--t-dim)]" />
            </button>
          ))}
          {hosts.length === 0 && !agentsError && (
            <button onClick={() => window.dispatchEvent(new Event("truss:add-host"))} className="w-full mx-0.5 px-2 py-2 rounded-md border border-dashed border-[var(--t-line2)] text-[11px] text-[var(--t-dim)] hover:text-[var(--t-mute)] hover:border-[var(--t-mute)] text-left">
              No hosts yet. Add one — the agent dials out, so no firewall holes.
            </button>
          )}
          {agentsError && (
            <div className="px-2 py-1.5 text-[11px] text-[var(--t-red)]" role="alert">
              Remote hosts unavailable. <button onClick={() => void store.refreshHosts()} className="underline">Retry</button>
            </div>
          )}
        </Section>
      </div>
      <button onClick={() => openPanel("settings")} className="shrink-0 flex items-center gap-2 h-9 px-3 border-t border-[var(--t-line)] text-[12px] text-[var(--t-mute)] hover:text-[var(--t-fg)] hover:bg-white/[0.02] text-left" title="Open Settings (Ctrl/Cmd+,)">
        <Icon name="settings" size={13} /> Settings
      </button>
    </aside>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="mt-3 pt-2 border-t border-[var(--t-line)]">
      <div className="flex items-center px-2 h-7 text-[10.5px] font-medium uppercase tracking-[0.08em] text-[var(--t-dim)]">
        {title}
        <span className="ml-auto">{action}</span>
      </div>
      {children}
    </div>
  );
}

function SessionRow({ s, now, archived, trashView }: { s: SessionMeta; now: number; archived?: boolean; trashView?: boolean }) {
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
      onClick={() => openSession(s.id)}
      onDoubleClick={() => openDailyDriver(s.id)}
      className={cn("group relative mx-0.5 flex items-center gap-2 px-2 t-session-row rounded-md cursor-pointer transition-colors", focused ? "bg-[var(--t-bg2)]" : "hover:bg-white/[0.03]")}
      title={`${s.title}\n${s.harness}${s.model ? ` · ${s.model}` : ""}\n${shortPath(s.cwd)}\n${STATE_META[s.state]?.hint ?? s.state}${archived ? "\narchived — hidden from the main list" : ""}\n(double-click: chat + trajectory + context)`}
    >
      {focused && <span className="absolute left-0 top-2 bottom-2 w-[2px] rounded-full bg-[var(--t-amber)]" />}
      <HarnessMark harness={s.harness} size={17} className={dead ? "opacity-45" : ""} />
      <span className={cn("flex-1 min-w-0 truncate text-[12.5px]", dead ? "text-[var(--t-mute)]" : "text-[var(--t-fg)]", archived && "opacity-60")}>{s.title}</span>
      {pending > 0 && (
        <span className="shrink-0 inline-grid place-items-center w-4 h-4 rounded-full bg-[var(--t-amber)] text-[#1b1305] text-[9.5px] font-bold t-pulse-soft" title="Permission waiting">{pending}</span>
      )}
      <span className="group-hover:hidden flex items-center gap-1.5 shrink-0">
        <span className="text-[10px] text-[var(--t-dim)] tabular-nums">{ago(+new Date(s.updated_at) || Date.parse(String(s.updated_at)), now)}</span>
        <StateDot state={s.state} size={6} />
      </span>
      <span className="hidden group-hover:flex items-center shrink-0" onClick={(e) => e.stopPropagation()}>
        {archived ? (
          <IconBtn icon="archive" label="Restore to the sidebar" className="w-6 h-6" onClick={() => store.archiveSession(s.id, false)} />
        ) : (
          <>
            <IconBtn icon="term" label="Shell in cwd" className="w-6 h-6" onClick={() => openAgentShell(s.id)} />
            <IconBtn icon="archive" label="Archive (hide from sidebar; keeps history)" className="w-6 h-6" onClick={() => store.archiveSession(s.id, true)} />
          </>
        )}
        {!dead && !archived && !trashView && <IconBtn icon="power" label="Close (stop process, keep history)" className="w-6 h-6" onClick={() => store.closeSession(s.id)} />}
        {trashView ? (
          <>
            <IconBtn icon="retry" label="Restore (back to the sidebar, history intact)" className="w-6 h-6" onClick={() => void store.restoreSession(s.id)} />
            <IconBtn
              icon="trash"
              label={confirm ? "Click again: gone forever, no undo" : "Delete forever (no undo)"}
              className={cn("w-6 h-6", confirm && "!text-[var(--t-red)] bg-[color-mix(in_oklab,var(--t-red)_15%,transparent)]")}
              onClick={() => (confirm ? store.purgeSession(s.id) : setConfirm(true))}
            />
          </>
        ) : (
          <IconBtn
            icon="trash"
            label={confirm ? "Click again to move to trash" : "Move to trash (recoverable for 30 days)"}
            className={cn("w-6 h-6", confirm && "!text-[var(--t-red)] bg-[color-mix(in_oklab,var(--t-red)_15%,transparent)]")}
            onClick={() => (confirm ? store.deleteSession(s.id) : setConfirm(true))}
          />
        )}
      </span>
    </div>
  );
}


/* ---------------- recently deleted (30-day trash) ---------------- */
function TrashSection() {
  const trash = useApp((s) => s.trash);
  const [open, setOpen] = useState(false);
  const now = useNow(30_000, open);
  useEffect(() => {
    void store.refreshTrash();
  }, []);
  if (trash.length === 0) return null;
  return (
    <div className="mt-2">
      <button
        className="w-full flex items-center gap-1.5 px-2 h-7 text-[10.5px] font-medium uppercase tracking-[0.08em] text-[var(--t-dim)] hover:text-[var(--t-mute)]"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="chev" size={9} className={cn("transition-transform", open && "rotate-90")} />
        <Icon name="trash" size={10} />
        <span>recently deleted</span>
        <span className="ml-auto tabular-nums">{trash.length}</span>
      </button>
      {open && trash.map((s) => <SessionRow key={s.id} s={s} now={now} trashView />)}
    </div>
  );
}


/* two-click bulk trash for a sidebar group (issue #4) */
function GroupTrash({ ids, name }: { ids: string[]; name: string }) {
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!confirm) return;
    const t = window.setTimeout(() => setConfirm(false), 3000);
    return () => window.clearTimeout(t);
  }, [confirm]);
  if (ids.length === 0) return null;
  return (
    <button
      className={cn("opacity-0 group-hover/grp:opacity-70 hover:!opacity-100", confirm && "!opacity-100 text-[var(--t-red)]")}
      title={confirm ? `Click again: move all ${ids.length} chats under “${name}” to trash` : `Move all chats under “${name}” to trash (recoverable 30 days; the folder is never touched)`}
      onClick={() => {
        if (!confirm) return setConfirm(true);
        setConfirm(false);
        void store.bulkDeleteSessions(ids);
      }}
    >
      <Icon name="trash" size={11} />
    </button>
  );
}
