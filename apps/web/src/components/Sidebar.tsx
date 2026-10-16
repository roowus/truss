import { useMemo, useState, useEffect, type ReactNode } from "react";
import { store, toMs, useApp, useNow } from "@/lib/store";
import { desktops, useDesktops } from "@/lib/desktops";
import { ago, shortPath, until } from "@/lib/format";
import { harnessDisplay, hostAliases } from "@/lib/device";
import { openAgentShell, openDailyDriver, openFreeShell, openPanel, openSession } from "@/lib/workspace";
import { HarnessMark, Icon, IconBtn, StateDot, TrussLogo, Spinner, STATE_META } from "./ui";
import type { HostInfo, SessionMeta, TerminalInfo } from "@/lib/proto";
import { clusterRestState, hostRowActions, sessionRowActions, shellRowActions, type SessionRowAction } from "@/lib/rowActions";
import { rowRenameTarget } from "@/lib/rowRename";
import { sidebarAttention } from "@/lib/unread";
import { sortWithPinned } from "@/lib/pinSort";
import { pinAffordance, pinVisibilityCls } from "@/lib/pinAffordance";
import {
  applyClick,
  bulkActions,
  createSelection,
  pruneSelection,
  type BulkAction,
  type SelectionState,
} from "@/lib/multiSelect";
import { cn } from "@/utils/cn";

export function Sidebar({ onNew }: { onNew: () => void }) {
  const order = useApp((s) => s.order);
  const sessions = useApp((s) => s.sessions);
  const loaded = useApp((s) => s.sessionsLoaded);
  const err = useApp((s) => s.sessionsError);
  const terminals = useApp((s) => s.terminals);
  const hosts = useApp((s) => s.hosts);
  const pairRequests = useApp((s) => s.pairRequests);
  const agentsError = useApp((s) => s.agentsError);
  const hostPrefs = useDesktops((s) => s.hosts);
  const groupMode = useDesktops((s) => s.settings.groupMode);
  const [q, setQ] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const now = useNow(15_000);
  /* issue #225: one selection over every row the sidebar renders — sessions,
     shells, hosts — so shift ranges and cmd/ctrl toggles span the sections
     the user actually sees. The model is pure (src/lib/multiSelect.ts); this
     is the only stateful bit. */
  const [sel, setSel] = useState<SelectionState>(() => createSelection());

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
    /* issue #86: pinned chats float to the top of their section (the group
       order itself is untouched); pinned archived chats lead the archive */
    return [
      [...g.entries()]
        .sort((a, b) => (a[0] === "" ? 1 : b[0] === "" ? -1 : a[0].localeCompare(b[0])))
        .map(([k, list]) => [k, sortWithPinned(list, (s) => !!s.pinned)] as [string, SessionMeta[]]),
      sortWithPinned(arch, (s) => !!s.pinned),
    ] as const;
  }, [order, sessions, q, groupMode]);

  /* issue #225: the ids the sidebar is actually rendering, in render order —
     sections top to bottom, collapsed groups and filtered-out chats absent.
     This array IS the range semantics: a shift-click ranges over what the
     user can see, never over rows the search box or a collapsed group hid. */
  const visibleIds = useMemo(() => {
    const ids: string[] = [];
    for (const [project, list] of groups) {
      const key = project || "__none";
      if (collapsed[key]) continue;
      for (const s of list) ids.push(s.id);
    }
    if (collapsed.__archived) for (const s of archived) ids.push(s.id);
    for (const t of sortWithPinned(terminals, (x) => !!x.pinned)) ids.push(t.id);
    for (const h of sortWithPinned(hosts, (x) => !!x.pinned)) ids.push(h.id);
    return ids;
  }, [groups, archived, collapsed, terminals, hosts]);

  /* rows that vanish (deleted, archived away, filtered out) drop out of the
     selection — the model's prune, applied on every visible-order change, so
     the bulk bar can never offer an action on a row that is gone */
  useEffect(() => {
    setSel((s) => {
      const next = pruneSelection(s, visibleIds);
      return next.ids.size === s.ids.size && next.anchor === s.anchor ? s : next;
    });
  }, [visibleIds]);

  const selectionCount = sel.ids.size;
  const actions = useMemo(() => bulkActions(sel, sidebarItems(sessions, terminals, hosts)), [sel, sessions, terminals, hosts]);

  /* Esc clears the selection (issue #225). Bound on the document so it works
     wherever focus sits inside the sidebar — but not while the user is typing
     in the search box or renaming a row, where Esc means "cancel". */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || selectionCount === 0) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      setSel(createSelection());
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selectionCount]);

  const onRowClick = (id: string, e: React.MouseEvent) =>
    setSel((s) => applyClick(s, id, { shift: e.shiftKey, meta: e.metaKey, ctrl: e.ctrlKey }, visibleIds));

  const clearSel = () => setSel(createSelection());

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

      {/* issue #225: the bulk action bar — the sidebar's top edge, only when
          something is selected. It does NOT replace the per-row clusters
          (those keep working); it adds the set-level actions, each carrying
          its own disabled reason when the set can't take it. */}
      {selectionCount > 0 && (
        <BulkBar
          count={selectionCount}
          actions={actions}
          sel={sel}
          sessions={sessions}
          terminals={terminals}
          hosts={hosts}
          onClear={clearSel}
        />
      )}

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
                {!isCol && list.map((s) => (
                  <SessionRow key={s.id} s={s} now={now} selected={sel.ids.has(s.id)} onRowClick={onRowClick} />
                ))}
              </div>
            );
          })
        )}

        {/* deleted chats live in the Trash tab (issue #146) — the sidebar
            used to carry a "recently deleted" strip here; the tab is the
            one surface now (developer call on PR #153) */}

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
            {collapsed.__archived && archived.map((s) => (
              <SessionRow key={s.id} s={s} now={now} archived selected={sel.ids.has(s.id)} onRowClick={onRowClick} />
            ))}
          </div>
        )}

        <Section title="shells" action={<IconBtn icon="plus" label="New shell" onClick={() => openFreeShell()} className="w-6 h-6" />}>
          {terminals.length === 0 ? (
            <div className="px-3 py-1 text-[11px] text-[var(--t-dim)]">None running.</div>
          ) : (
            /* issue #86: pinned shells lead the section, stable within each partition */
            sortWithPinned(terminals, (t) => !!t.pinned).map((t) => (
              <ShellRow key={t.id} t={t} selected={sel.ids.has(t.id)} onRowClick={onRowClick} />
            ))
          )}
        </Section>

        <Section title="remote hosts" action={<IconBtn icon="plus" label="Add host" className="w-5 h-5" onClick={() => window.dispatchEvent(new Event("truss:add-host"))} />}>
          {/* auto-pairing (issue #111 review): a device that downloaded and
              ran the installer asks here; Allow is the whole handshake */}
          {pairRequests.map((r) => <PairRequestRow key={r.id} r={r} />)}
          {sortWithPinned(hosts, (h) => !!h.pinned).map((h) => (
            <HostRow key={h.id} h={h} alias={hostPrefs[h.id]?.alias} selected={sel.ids.has(h.id)} onRowClick={onRowClick} />
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

/* shared empty map so rows render referentially stable while the read
   marks have not loaded/seeded yet (issue #173) */
const NO_READ_MARKS: Record<string, number> = {};

function SessionRow({
  s,
  now,
  archived,
  selected,
  onRowClick,
}: {
  s: SessionMeta;
  now: number;
  archived?: boolean;
  selected?: boolean;
  onRowClick: (id: string, e: React.MouseEvent) => void;
}) {
  const focused = useApp((st) => st.focused === s.id);
  const focusedId = useApp((st) => st.focused ?? null);
  const readAt = useDesktops((st) => st.readAt);
  const pending = useApp((st) => st.views[s.id]?.pending.length ?? 0);
  const hosts = useApp((st) => st.hosts);
  const hostPrefs = useDesktops((st) => st.hosts);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(false), 3000);
    return () => clearTimeout(t);
  }, [confirm]);
  /* double-click the name to rename inline (issue #147) */
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const renameTarget = rowRenameTarget({ kind: "session", id: s.id });
  const finishRename = () => {
    const next = name.trim();
    setEditing(false);
    if (next && next !== s.title) void store.renameSession(s.id, next);
  };
  const dead = s.state === "closed" || s.state === "error";
  /* issue #173: unread shows as a violet bar on the row's left edge plus a
     medium title — the same slot the amber focused bar uses, which is free
     exactly then (the focused session is never unread). The state dot keeps
     the right edge to itself: one glyph per side, no dot pair. Focusing the
     session marks it read (the desktops store writes the mark), clearing it. */
  const attention = sidebarAttention(
    { id: s.id, updatedAt: toMs(s.updated_at), state: s.state, createdAt: toMs(s.created_at) },
    readAt ?? NO_READ_MARKS,
    focusedId,
  );
  /* ONE action cluster per row (issue #110): the pin shares the same array,
     flex container, and gap as every other action — before this it was a
     bespoke element mid-row, so its gap to the cluster could never match
     the cluster's own spacing. The pin anchors LAST in the array (issue
     #156): the same right-edge pixel at rest and on hover, so it never
     dodges the pointer. The pin button IS the indicator (issue #99):
     solid + always visible when pinned, hollow + hover-only when not.
     Badge/timestamp/state stay indicators outside the cluster. */
  const actions = sessionRowActions({ pinned: !!s.pinned, archived, dead });
  /* issue #140: the resting cluster comes from the actions themselves — an
     all-hover cluster rests hidden (nothing reserves space, so the
     timestamp+dot reach the row's right edge); a pinned row rests with only
     the solid pin */
  const rest = clusterRestState(actions);
  const runAction = (a: SessionRowAction) => {
    /* destructive entries keep the two-click confirm (the #85 rule) */
    if (a.confirm) {
      if (!confirm) return setConfirm(true);
      setConfirm(false);
    }
    switch (a.id) {
      case "pin": return void store.pinSession(s.id, !s.pinned);
      /* the displaced double-click (issue #147): chat + trajectory + context */
      case "open-all": return openDailyDriver(s.id);
      case "shell": return openAgentShell(s.id);
      case "archive": return void store.archiveSession(s.id, true);
      case "unarchive": return void store.archiveSession(s.id, false);
      case "close": return void store.closeSession(s.id);
      case "trash": return void store.deleteSession(s.id);
    }
  };
  return (
    <div
      /* the row is a tab stop so keyboard users keep a path to the cluster
         now that hover-only members take no layout space at rest (issue
         #140, replacing the opacity-0 slot-keeping that kept the pin
         tabbable): focus reveals the cluster via group-focus-within, exactly
         like hover does; Enter/Space on the row itself opens the session
         (the HostRow pattern, #85) */
      role="button"
      /* an explicit name: without it the row announces as the concatenation
         of title + timestamp + state text (audit B2) */
      aria-label={s.title}
      aria-pressed={selected || undefined}
      tabIndex={0}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
          e.preventDefault();
          openSession(s.id);
        }
      }}
      /* issue #225: EVERY click goes through the selection model — a plain
         click collapses the selection to this row (anchor = it) AND opens
         the session, which is the "plain click selects exactly one" contract;
         shift/cmd/ctrl build the set and never navigate. Before this the
         plain branch short-circuited to openSession, so the model's collapse
         path was unreachable from the sidebar and a stale multi-selection
         survived the click (audit round 1, B1). */
      onClick={(e) => {
        onRowClick(s.id, e);
        if (!e.shiftKey && !e.metaKey && !e.ctrlKey) openSession(s.id);
      }}
      className={cn(
        "group relative mx-0.5 flex items-center gap-2 px-2 t-session-row rounded-md transition-colors cursor-pointer",
        selected ? "bg-[color-mix(in_oklab,var(--t-amber)_14%,transparent)]" : focused ? "bg-[var(--t-bg2)]" : "hover:bg-white/[0.03]",
      )}
      title={`${s.title}\n${harnessDisplay(s.harness, hosts, hostAliases(hostPrefs))}${s.model ? ` · ${s.model}` : ""}\n${shortPath(s.cwd)}\n${STATE_META[s.state]?.hint ?? s.state}${attention === "unread" ? "\nunread activity (open to mark it read)" : ""}${archived ? "\narchived — hidden from the main list" : ""}${renameTarget ? "\n(double-click the name to rename)" : ""}`}
    >
      {selected ? (
        <span className="absolute left-0 top-2 bottom-2 w-[2px] rounded-full bg-[var(--t-amber)]" />
      ) : focused ? (
        <span className="absolute left-0 top-2 bottom-2 w-[2px] rounded-full bg-[var(--t-amber)]" />
      ) : attention === "unread" ? (
        <span className="absolute left-0 top-2 bottom-2 w-[2px] rounded-full bg-[var(--t-violet)]" />
      ) : null}
      <HarnessMark harness={s.harness} size={17} className={dead ? "opacity-45" : ""} />
      {editing ? (
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter") finishRename();
            else if (e.key === "Escape") setEditing(false);
          }}
          onBlur={finishRename}
          className="flex-1 min-w-0 bg-[var(--t-bg1)] border border-[var(--t-line2)] rounded px-1 text-[12.5px] text-[var(--t-fg)] outline-none"
        />
      ) : (
        <span
          onDoubleClick={renameTarget ? () => { setName(s.title); setEditing(true); } : undefined}
          className={cn("flex-1 min-w-0 truncate text-[12.5px]", dead ? "text-[var(--t-mute)]" : "text-[var(--t-fg)]", archived && "opacity-60", attention === "unread" && "font-medium")}
        >{s.title}</span>
      )}
      {pending > 0 && (
        <span className="shrink-0 inline-grid place-items-center w-4 h-4 rounded-full bg-[var(--t-amber)] text-[#1b1305] text-[9.5px] font-bold t-pulse-soft" title="Permission waiting">{pending}</span>
      )}
      <span className="group-hover:hidden group-focus-within:hidden flex items-center gap-1.5 shrink-0">
        <span className="text-[10px] text-[var(--t-dim)] tabular-nums">{ago(+new Date(s.updated_at) || Date.parse(String(s.updated_at)), now)}</span>
        <StateDot state={s.state} size={6} />
      </span>
      {/* one container, one gap (issue #110), resting state from
          clusterRestState (issue #140): no always-visible member → the whole
          cluster hides until hover/focus, so nothing (not even an
          opacity-0 pin) reserves space and the timestamp+dot sit flush at
          the right edge; pinned → only the solid pin rests. Hover members
          take zero layout space at rest (display, not opacity) — keyboard
          reach comes from the row being a tab stop, with group-focus-within
          revealing the cluster just like hover. */}
      <span className={cn("items-center shrink-0", rest.cls, "group-focus-within:flex")} onClick={(e) => e.stopPropagation()}>
        {actions.map((a) => (
          <IconBtn
            key={a.id}
            icon={a.icon}
            label={confirm && a.confirm ? (CONFIRM_LABEL[a.id] ?? a.label) : a.label}
            active={a.id === "pin" ? !!s.pinned : undefined}
            className={cn(
              "w-6 h-6 shrink-0",
              a.visible === "hover" && "hidden group-hover:inline-grid group-focus-within:inline-grid",
              confirm && a.confirm && "!text-[var(--t-red)] bg-[color-mix(in_oklab,var(--t-red)_15%,transparent)]",
            )}
            onClick={() => runAction(a)}
          />
        ))}
      </span>
    </div>
  );
}

/* second-click labels for the session row's destructive actions; a future
   confirm action without an entry falls back to its first-click label at
   the call site, so a missing key can never blank the tooltip */
const CONFIRM_LABEL: Record<string, string> = {
  trash: "Click again to move to trash",
};

/* the bulk bar's armed tooltips — the set-level consequence, by action id
   (audit round 1, B4): the single-row actions name what each kind loses, and
   the bulk path must not be vaguer than the one it multiplies */
const CONFIRM_HINT: Record<string, string> = {
  delete: "Click again to confirm — chats go to trash (recoverable 30 days), shells are killed, hosts are deleted (drops their agent)",
  archive: "Click again to archive the selected chats",
  pin: "Click again to pin the selection",
};


/* ---------------- shells + remote hosts rows (issue #85) ----------------
   Actions come from src/lib/rowActions.ts (looked up by id, never by
   position) — open is the row click itself, the rest render as hover
   actions with the session-row pattern: the destructive one takes a
   two-click confirm. */

/* the two-click confirm, shared by the destructive row actions: first click
   arms (auto-disarm after 3s), second click fires */
function useTwoClickConfirm(): [boolean, (fire: () => void) => void] {
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!confirm) return;
    const tm = setTimeout(() => setConfirm(false), 3000);
    return () => clearTimeout(tm);
  }, [confirm]);
  const click = (fire: () => void) => {
    if (!confirm) return setConfirm(true);
    setConfirm(false);
    fire();
  };
  return [confirm, click];
}

const confirmCls = (confirm: boolean) =>
  cn("w-6 h-6", confirm && "!text-[var(--t-red)] bg-[color-mix(in_oklab,var(--t-red)_15%,transparent)]");

function ShellRow({ t, selected, onRowClick }: { t: TerminalInfo; selected?: boolean; onRowClick: (id: string, e: React.MouseEvent) => void }) {
  const [confirm, confirmClick] = useTwoClickConfirm();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");

  const actions = shellRowActions(t);
  const rename = actions.find((a) => a.id === "rename");
  const kill = actions.find((a) => a.dangerous);
  const dead = t.alive === false;
  /* pin uses opacity, not display, so it stays in the tab order — focus
     reveals it like hover does (issue #86); since issue #99 the button IS
     the indicator: solid + always visible when pinned */
  const pin = pinAffordance(!!t.pinned);

  const finishRename = () => {
    const next = name.trim();
    setEditing(false);
    if (next && next !== t.title) void store.renameTerminal(t.id, next);
  };

  return (
    <div
      className={cn(
        "group relative flex items-center gap-2 mx-0.5 px-2 h-7 rounded-md cursor-pointer",
        selected ? "bg-[color-mix(in_oklab,var(--t-amber)_14%,transparent)]" : "hover:bg-white/[0.03]",
      )}
      aria-pressed={selected || undefined}
      /* issue #225: all clicks route through the model (audit round 1, B1) —
         plain collapses to this row and opens the panel */
      onClick={(e) => {
        onRowClick(t.id, e);
        if (!e.shiftKey && !e.metaKey && !e.ctrlKey) openPanel("terminal", { terminalId: t.id, title: t.title });
      }}
      title={t.cwd ? shortPath(t.cwd) : undefined}
    >
      {selected && <span className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-[var(--t-amber)]" />}
      <Icon name="term" size={12} className={dead ? "text-[var(--t-red)]" : "text-[var(--t-dim)]"} />
      {editing ? (
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter") finishRename();
            else if (e.key === "Escape") setEditing(false);
          }}
          onBlur={finishRename}
          className="flex-1 min-w-0 bg-[var(--t-bg1)] border border-[var(--t-line2)] rounded px-1 text-[12px] text-[var(--t-fg)] outline-none"
        />
      ) : (
        <span
          onDoubleClick={rowRenameTarget({ kind: "terminal", id: t.id }) ? () => { setName(t.title ?? ""); setEditing(true); } : undefined}
          title="Double-click to rename"
          className="text-[12px] text-[var(--t-fg2)] truncate"
        >{t.title ?? t.id}</span>
      )}
      {/* one cluster, one gap (issue #110): the pin anchors LAST in the same
          container as the other actions (issue #156) — the same right-edge
          pixel at rest and on hover, so it never dodges the pointer. Its
          opacity rule keeps the slot and the tab order (#86); rename/kill
          reveal on hover to the pin's LEFT, inside the same box.
          rowActions' shell array itself keeps its #85 shape (open/rename/kill
          is a pinned contract), so the pin joins at render time. */}
      <span className="ml-auto flex items-center shrink-0" onClick={(e) => e.stopPropagation()}>
        {rename && (
          <IconBtn
            icon={rename.icon ?? "edit"}
            label={rename.label}
            className="hidden group-hover:inline-grid w-6 h-6"
            onClick={() => {
              setName(t.title ?? "");
              setEditing(true);
            }}
          />
        )}
        {kill && (
          <IconBtn
            icon={kill.icon ?? "x"}
            label={confirm ? (dead ? "Click again: remove this exited shell" : "Click again: kill this shell") : kill.label}
            className={cn(confirmCls(confirm), "hidden group-hover:inline-grid")}
            onClick={() => confirmClick(() => void desktops.killTerminal(t.id))}
          />
        )}
        <IconBtn
          icon={pin.icon}
          label={pin.actionLabel}
          active={!!t.pinned}
          className={cn("w-6 h-6", pinVisibilityCls(pin.visible))}
          onClick={() => void store.pinTerminal(t.id, !t.pinned)}
        />
      </span>
    </div>
  );
}

/* auto-pairing (issue #111 review): a device that ran the installer is
   asking to join. The Allow/Deny click is the entire trust decision, so the
   row stays loud until it is answered; the request dies on its own after
   10 minutes even if ignored. */
function PairRequestRow({ r }: { r: import("@/lib/proto").PairRequestInfo }) {
  const [busy, setBusy] = useState(false);
  const decide = (fn: (id: string) => Promise<void>) => {
    setBusy(true);
    void fn(r.id).finally(() => setBusy(false));
  };
  return (
    <div className="mx-0.5 mb-1 rounded-md border border-[var(--t-amber)]/40 bg-[var(--t-amber)]/5 px-2 py-1.5">
      <div className="flex items-center gap-2 text-[12px] text-[var(--t-fg)]">
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--t-amber)] shrink-0 animate-pulse" />
        <Icon name="host" size={12} className="text-[var(--t-amber)] shrink-0" />
        <span className="flex-1 truncate">{r.hostname} wants to pair</span>
      </div>
      <div className="mt-0.5 pl-3.5 text-[10px] text-[var(--t-dim)] truncate">
        {r.os} · from {r.sourceIp}{r.tailscaleIp && r.tailscaleIp !== r.sourceIp ? ` (tailnet ${r.tailscaleIp})` : ""} · expires in {until(r.expiresAt)}
      </div>
      <div className="mt-1.5 flex gap-1.5 pl-3.5">
        <button
          disabled={busy}
          onClick={() => decide((id) => store.approvePairRequest(id))}
          className="px-2 py-0.5 rounded text-[10.5px] font-medium bg-[var(--t-amber)] text-black hover:brightness-110 disabled:opacity-50"
        >
          Allow
        </button>
        <button
          disabled={busy}
          onClick={() => decide((id) => store.denyPairRequest(id))}
          className="px-2 py-0.5 rounded text-[10.5px] border border-[var(--t-line2)] text-[var(--t-mute)] hover:text-[var(--t-fg)] disabled:opacity-50"
        >
          Deny
        </button>
      </div>
    </div>
  );
}

function HostRow({ h, alias, selected, onRowClick }: { h: HostInfo; alias?: string; selected?: boolean; onRowClick: (id: string, e: React.MouseEvent) => void }) {
  const [confirm, confirmClick] = useTwoClickConfirm();
  const hosts = useApp((st) => st.hosts);
  const hostPrefs = useDesktops((st) => st.hosts);
  /* double-click the name to rename the host's label inline (issue #147);
     the id is the identity and never changes. The edit targets the shared
     label itself — prefill/compare h.label, never the alias: a per-user
     alias stays a HostPanel preference and must not leak into the label
     every client sees (audit round 1) */
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const renameTarget = rowRenameTarget({ kind: "host", id: h.id });
  const finishRename = () => {
    const next = name.trim();
    setEditing(false);
    if (next && next !== h.label) void store.renameHost(h.id, next);
  };

  const actions = hostRowActions(h);
  const del = actions.find((a) => a.dangerous);
  const open = () => openPanel("host", { hostId: h.id, title: alias || h.label });
  /* a real button now that the row is a div (pre-#85 the row itself was
     a <button>, so pin had to be a span); opacity, not display, keeps it
     tabbable — focus reveals it like hover does (issue #86, audit B4).
     Since issue #99 the button IS the indicator: solid + always visible
     when pinned */
  const pin = pinAffordance(!!h.pinned);

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected || undefined}
      /* issue #225: all clicks route through the model (audit round 1, B1) —
         plain collapses to this row and opens the host */
      onClick={(e) => {
        onRowClick(h.id, e);
        if (!e.shiftKey && !e.metaKey && !e.ctrlKey) open();
      }}
      onKeyDown={(e) => {
        /* the row was a real <button> before #85 — keyboard opens stay */
        if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
          e.preventDefault();
          open();
        }
      }}
      className={cn(
        "group relative w-full flex items-center gap-2 mx-0.5 px-2 h-7 text-[12px] text-[var(--t-mute)] hover:text-[var(--t-fg)] rounded-md text-left cursor-pointer",
        selected ? "bg-[color-mix(in_oklab,var(--t-amber)_14%,transparent)] text-[var(--t-fg)]" : "hover:bg-white/[0.03]",
      )}
      title={`${h.label} · ${h.online ? `online · ${h.agent?.adapters.map((x) => harnessDisplay(x, hosts, hostAliases(hostPrefs))).join(", ")}` : "offline"} · open host details`}
    >
      {selected && <span className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-[var(--t-amber)]" />}
      <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", h.online ? "bg-[var(--t-teal)]" : "bg-[var(--t-line2)]")} />
      <Icon name="host" size={12} className={h.online ? "text-[var(--t-sky)]" : "text-[var(--t-dim)]"} />
      {editing ? (
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter") finishRename();
            else if (e.key === "Escape") setEditing(false);
          }}
          onBlur={finishRename}
          className="flex-1 min-w-0 bg-[var(--t-bg1)] border border-[var(--t-line2)] rounded px-1 text-[12px] text-[var(--t-fg)] outline-none"
        />
      ) : (
        <span
          onDoubleClick={renameTarget ? () => { setName(h.label); setEditing(true); } : undefined}
          title={renameTarget ? (alias ? `Double-click to rename the shared label (your alias “${alias}” stays)` : "Double-click to rename") : undefined}
          className={cn("flex-1 truncate", !h.online && "opacity-50")}
        >{alias || h.label}</span>
      )}
      {h.revoked && !confirm && <span className="text-[8.5px] font-mono uppercase text-[var(--t-red)] shrink-0 group-hover:hidden">revoked</span>}
      {/* one cluster, one gap (issue #110): the pin anchors LAST in the same
          container as delete (issue #156) — the same right-edge pixel at
          rest and on hover, so it never dodges the pointer. Its opacity
          rule keeps the slot and the tab order (#86); delete reveals on
          hover to the pin's LEFT, inside the same box. rowActions' host
          array keeps its #85 shape (open/delete is a pinned contract), so
          the pin joins at render time. */}
      <span className="flex items-center shrink-0" onClick={(e) => e.stopPropagation()}>
        {del && (
          <IconBtn
            icon={del.icon ?? "trash"}
            label={confirm ? `Click again: delete ${alias || h.label} (drops its agent if connected)` : del.label}
            className={cn(confirmCls(confirm), "hidden group-hover:inline-grid")}
            onClick={() => confirmClick(() => void store.deleteHost(h.id))}
          />
        )}
        <IconBtn
          icon={pin.icon}
          label={pin.actionLabel}
          active={!!h.pinned}
          className={cn("w-6 h-6", pinVisibilityCls(pin.visible))}
          onClick={() => void store.pinHost(h.id, !h.pinned)}
        />
      </span>
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

/* ---------------- multi-select bulk actions (issue #225) ----------------
   The kind map the pure model needs (src/lib/multiSelect.ts `bulkActions`):
   the sidebar is the only place that knows a row is a chat, a shell, or a
   host. The model stays kind-agnostic so #226 can drive it from a Files
   tree with its own descriptors. */
function sidebarItems(
  sessions: Record<string, SessionMeta>,
  terminals: TerminalInfo[],
  hosts: HostInfo[],
): { id: string; kind: string }[] {
  const items: { id: string; kind: string }[] = [];
  for (const id of Object.keys(sessions)) items.push({ id, kind: "session" });
  for (const t of terminals) items.push({ id: t.id, kind: "shell" });
  for (const h of hosts) items.push({ id: h.id, kind: "host" });
  return items;
}

/* The bulk bar. It sits at the sidebar's top edge and appears only while
   something is selected; it never replaces the per-row clusters (a row's own
   confirm-delete still works), it adds the set-level actions. Each action
   carries its own reason when the set can't take it (a mixed-kind set can't
   be deleted wholesale), and the destructive one keeps the same two-click
   gate the single-row path uses (issue #85) — a bulk delete is MORE
   destructive, so it must never get a lighter confirmation. */
function BulkBar({
  count,
  actions,
  sel,
  sessions,
  terminals,
  hosts,
  onClear,
}: {
  count: number;
  actions: BulkAction[];
  sel: SelectionState;
  sessions: Record<string, SessionMeta>;
  terminals: TerminalInfo[];
  hosts: HostInfo[];
  onClear: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(false), 3000);
    return () => clearTimeout(t);
  }, [confirm]);

  const ids = [...sel.ids];
  const kill = (action: BulkAction) => {
    /* reason-disabled actions do nothing and say why (via title) */
    if (action.disabled) return;
    if (action.confirm) {
      if (!confirm) return setConfirm(true);
      setConfirm(false);
    }
    switch (action.id) {
      case "pin": {
        /* pin the set, then clear: the gesture is done */
        for (const id of ids) {
          if (sessions[id]) void store.pinSession(id, true);
          else if (terminals.some((t) => t.id === id)) void store.pinTerminal(id, true);
          else if (hosts.some((h) => h.id === id)) void store.pinHost(id, true);
        }
        return onClear();
      }
      case "archive": {
        for (const id of ids) if (sessions[id]) void store.archiveSession(id, true);
        return onClear();
      }
      case "delete": {
        const sessionIds = ids.filter((id) => sessions[id]);
        const shellIds = ids.filter((id) => terminals.some((t) => t.id === id));
        const hostIds = ids.filter((id) => hosts.some((h) => h.id === id));
        if (sessionIds.length) void store.bulkDeleteSessions(sessionIds);
        for (const id of shellIds) void desktops.killTerminal(id);
        for (const id of hostIds) void store.deleteHost(id);
        return onClear();
      }
    }
  };

  return (
    <div className="shrink-0 mx-1.5 mb-1.5 px-2 py-1.5 rounded-md border border-[var(--t-amber)]/40 bg-[var(--t-amber)]/[0.07]" role="toolbar" aria-label={`${count} selected`}>
      <div className="flex items-center gap-1.5 text-[11px] text-[var(--t-fg)]">
        <span className="font-medium tabular-nums">{count} selected</span>
        <button
          className="ml-auto px-1.5 py-0.5 rounded text-[10.5px] text-[var(--t-mute)] hover:text-[var(--t-fg)] border border-[var(--t-line2)]"
          title="Clear selection (Esc)"
          onClick={onClear}
        >
          Clear
        </button>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {actions.map((a) => {
          /* audit round 1 (B4): the bulk path is the MORE destructive one, so
             its second click repeats the per-kind consequence the single-row
             actions spell out — "kills the shells", "drops the agent" — never
             a bare "Click again to confirm" */
          const armed = confirm && !!a.confirm;
          const title = a.disabled ?? (armed ? (CONFIRM_HINT[a.id] ?? "Click again to confirm") : a.label);
          return (
            <button
              key={a.id}
              disabled={!!a.disabled}
              title={title}
              aria-label={armed ? title : a.label}
              onClick={() => kill(a)}
              className={cn(
                "px-2 py-0.5 rounded text-[10.5px] font-medium border transition-colors",
                a.disabled
                  ? "border-[var(--t-line)] text-[var(--t-dim)] cursor-not-allowed"
                  : a.confirm
                    ? confirm
                      ? "border-[var(--t-red)] bg-[color-mix(in_oklab,var(--t-red)_15%,transparent)] text-[var(--t-red)]"
                      : "border-[var(--t-line2)] text-[var(--t-mute)] hover:text-[var(--t-red)] hover:border-[var(--t-red)]/50"
                    : "border-[var(--t-line2)] text-[var(--t-mute)] hover:text-[var(--t-fg)] hover:border-[var(--t-mute)]",
              )}
            >
              {armed ? `Click again: ${a.label}` : a.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
