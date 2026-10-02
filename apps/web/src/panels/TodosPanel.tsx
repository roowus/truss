import { useMemo, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { store, useApp, useNow } from "@/lib/store";
import { ago, shortPath } from "@/lib/format";
import { Btn, Empty, Icon, Select, Spinner } from "@/components/ui";
import { openPanel } from "@/lib/workspace";
import type { TodoItem, TodoPriority, TodoSubtask } from "@/lib/proto";
import { cn } from "@/utils/cn";

/**
 * Todos — the user's checklist, filed mostly by agents (file_todo MCP tool).
 * Four views (grouped list / priority board / table / deadline calendar),
 * filters by project · agent · folder · label · search. The user edits
 * anything; agents edit only their own session's todos (or after an approved
 * access card).
 */

type View = "list" | "board" | "table" | "calendar";
type GroupBy = "project" | "folder" | "agent" | "label" | "none";

const PRI_ORDER: TodoPriority[] = ["urgent", "high", "normal", "low"];
const PRI_STYLE: Record<TodoPriority, { color: string; label: string }> = {
  urgent: { color: "var(--t-red)", label: "urgent" },
  high: { color: "var(--t-amber)", label: "high" },
  normal: { color: "var(--t-sky)", label: "normal" },
  low: { color: "var(--t-dim)", label: "low" },
};

export function TodosPanel(_props: IDockviewPanelProps) {
  const todos = useApp((s) => s.todos);
  const loaded = useApp((s) => s.todosLoaded);
  const sessions = useApp((s) => s.sessions);
  const now = useNow(30_000);
  const [view, setView] = useState<View>("list");
  const [groupBy, setGroupBy] = useState<GroupBy>("project");
  const [q, setQ] = useState("");
  const [fProject, setFProject] = useState("");
  const [fHarness, setFHarness] = useState("");
  const [fFolder, setFFolder] = useState("");
  const [fLabel, setFLabel] = useState("");
  const [showDone, setShowDone] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ title: "", priority: "normal" as TodoPriority, deadline: "", labels: "" });

  const all = useMemo(() => Object.values(todos), [todos]);

  /* filter facets from live data */
  const facets = useMemo(() => {
    const projects = new Set<string>();
    const harnesses = new Set<string>();
    const folders = new Set<string>();
    const labels = new Set<string>();
    for (const t of all) {
      const s = t.sessionId ? sessions[t.sessionId] : undefined;
      if (s?.project) projects.add(s.project);
      if (s) harnesses.add(s.harness);
      if (s?.cwd) folders.add(s.cwd);
      t.labels.forEach((l) => labels.add(l));
    }
    const sort = (x: Set<string>) => [...x].sort();
    return { projects: sort(projects), harnesses: sort(harnesses), folders: sort(folders), labels: sort(labels) };
  }, [all, sessions]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all.filter((t) => {
      if (!showDone && t.status !== "open") return false;
      if (showDone && t.status === "dropped") return false;
      const s = t.sessionId ? sessions[t.sessionId] : undefined;
      if (fProject && s?.project !== fProject) return false;
      if (fHarness && s?.harness !== fHarness) return false;
      if (fFolder && s?.cwd !== fFolder) return false;
      if (fLabel && !t.labels.includes(fLabel)) return false;
      if (needle && !`${t.title} ${t.notes} ${t.labels.join(" ")}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [all, sessions, q, fProject, fHarness, fFolder, fLabel, showDone]);

  const patch = (id: string, p: Record<string, unknown>) => void store.be?.updateTodo(id, p).catch((e) => store.toast("error", "Couldn't update the todo", e.message));

  const submit = async () => {
    if (!form.title.trim()) return;
    await store.be?.createTodo({
      title: form.title.trim(),
      priority: form.priority,
      deadline: form.deadline ? new Date(form.deadline + "T23:59:59").getTime() : null,
      labels: form.labels ? form.labels.split(",").map((l) => l.trim()).filter(Boolean) : [],
    }).catch((e) => store.toast("error", "Couldn't create the todo", e.message));
    setCreating(false);
    setForm({ title: "", priority: "normal", deadline: "", labels: "" });
  };

  if (!loaded) return <div className="h-full grid place-items-center bg-[var(--t-bg1)]"><Spinner /></div>;

  return (
    <div className="h-full flex flex-col bg-[var(--t-bg1)] t-panel">
      {/* header */}
      <div className="shrink-0 flex items-center gap-1.5 px-3 h-9 border-b border-[var(--t-line)]">
        <Icon name="check" size={13} className="text-[var(--t-teal)]" />
        <span className="text-[12px] text-[var(--t-fg)] font-medium">Todos</span>
        <span className="font-mono text-[10px] text-[var(--t-dim)]">{filtered.filter((t) => t.status === "open").length} open</span>
        <div className="ml-auto flex items-center gap-1">
          <div className="flex items-center rounded bg-[var(--t-bg0)] border border-[var(--t-line)] overflow-hidden">
            {(["list", "board", "table", "calendar"] as View[]).map((v) => (
              <button key={v} onClick={() => setView(v)} className={cn("px-2 h-6 text-[10.5px] capitalize", view === v ? "bg-white/[0.07] text-[var(--t-fg)]" : "text-[var(--t-dim)] hover:text-[var(--t-mute)]")} title={`${v} view`}>{v}</button>
            ))}
          </div>
          <Btn size="xs" variant="ghost" onClick={() => setShowDone((v) => !v)} title="Show completed/dropped">{showDone ? "Hide done" : "Show done"}</Btn>
          <Btn size="xs" variant="outline" icon="plus" onClick={() => setCreating((v) => !v)}>New</Btn>
        </div>
      </div>

      {/* filter bar */}
      <div className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 border-b border-[var(--t-line)] flex-wrap">
        <div className="flex items-center gap-1.5 h-6 px-2 rounded bg-[var(--t-bg0)] border border-[var(--t-line)]">
          <Icon name="search" size={10} className="text-[var(--t-dim)]" />
          <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQ("")} placeholder="search" className="w-28 bg-transparent text-[11.5px] outline-none text-[var(--t-fg)] placeholder:text-[var(--t-dim)]" />
        </div>
        {view === "list" && (
          <Select size="bar" width={118} ariaLabel="Group by" value={groupBy} onChange={(v) => setGroupBy(v as GroupBy)} options={[
            { value: "project", label: "by project" }, { value: "folder", label: "by folder" }, { value: "agent", label: "by agent" }, { value: "label", label: "by label" }, { value: "none", label: "flat" },
          ]} />
        )}
        <Facet label="project" value={fProject} values={facets.projects} onChange={setFProject} />
        <Facet label="agent" value={fHarness} values={facets.harnesses} onChange={setFHarness} />
        <Facet label="folder" value={fFolder} values={facets.folders} onChange={setFFolder} short />
        <Facet label="label" value={fLabel} values={facets.labels} onChange={setFLabel} />
      </div>

      {creating && (
        <div className="shrink-0 border-b border-[var(--t-line)] bg-[var(--t-bg2)] px-3 py-2 flex items-center gap-2 flex-wrap">
          <input autoFocus value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} onKeyDown={(e) => e.key === "Enter" && void submit()} placeholder="what needs doing…" className="t-input flex-1 min-w-40" />
          <Select width={104} ariaLabel="Priority" value={form.priority} onChange={(v) => setForm({ ...form, priority: v as TodoPriority })} options={PRI_ORDER.map((p) => ({ value: p, label: p }))} />
          <input type="date" value={form.deadline} onChange={(e) => setForm({ ...form, deadline: e.target.value })} className="t-input w-34 font-mono text-[11px]" title="Deadline (optional)" />
          <input value={form.labels} onChange={(e) => setForm({ ...form, labels: e.target.value })} placeholder="labels, comma-sep" className="t-input w-32" />
          <Btn size="xs" variant="amber" disabled={!form.title.trim()} onClick={() => void submit()}>Add</Btn>
          <Btn size="xs" variant="ghost" onClick={() => setCreating(false)}>Cancel</Btn>
        </div>
      )}

      {/* body */}
      <div className="flex-1 min-h-0 overflow-auto t-scroll">
        {filtered.length === 0 ? (
          <Empty icon="check" title="Nothing here">{all.length === 0 ? "Agents file todos with the file_todo tool — or add your own with New." : "No todos match the filters."}</Empty>
        ) : view === "board" ? (
          <BoardView items={filtered} sessions={sessions} now={now} patch={patch} />
        ) : view === "table" ? (
          <TableView items={filtered} sessions={sessions} now={now} patch={patch} />
        ) : view === "calendar" ? (
          <CalendarView items={filtered} sessions={sessions} now={now} patch={patch} />
        ) : (
          <ListView items={filtered} sessions={sessions} now={now} patch={patch} groupBy={groupBy} />
        )}
      </div>
    </div>
  );
}

/* ── shared bits ── */

/* The facet dropdowns sit on the filter bar next to the search box, so they
   take the compact 24px bar size like Group by, Sort and State (issue #11).
   Facet is only used on that row; a dialog facet would want the form size. */
function Facet({ label, value, values, onChange, short }: { label: string; value: string; values: string[]; onChange: (v: string) => void; short?: boolean }) {
  if (values.length === 0) return null;
  return (
    /* the facets live in the filter bar, so they take the compact size —
       Select's own default is the 34px form height */
    <Select
      size="bar"
      width={short ? 130 : 112}
      ariaLabel={`Filter by ${label}`}
      value={value}
      onChange={onChange}
      options={[{ value: "", label: `${label}: all` }, ...values.map((v) => ({ value: v, label: short ? shortPath(v) : v, hint: short ? v : undefined }))]}
    />
  );
}

function groupKeyOf(t: TodoItem, sessions: Record<string, { project?: string; cwd?: string; harness?: string } | undefined>, by: GroupBy): string {
  const s = t.sessionId ? sessions[t.sessionId] : undefined;
  if (by === "project") return s?.project ?? "no project";
  if (by === "folder") return s?.cwd ?? "no folder";
  if (by === "agent") return s?.harness ?? "user";
  if (by === "label") return t.labels[0] ?? "unlabeled";
  return "";
}

const prioRank = (p: TodoPriority) => PRI_ORDER.indexOf(p);

function sortTodos(items: TodoItem[]): TodoItem[] {
  return [...items].sort((a, b) =>
    (a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1) ||
    prioRank(a.priority) - prioRank(b.priority) ||
    (a.deadline ?? Infinity) - (b.deadline ?? Infinity) ||
    b.updatedAt - a.updatedAt,
  );
}

/* ── list view (grouped) ── */
function ListView({ items, sessions, now, patch, groupBy }: ViewProps & { groupBy: GroupBy }) {
  const groups = new Map<string, TodoItem[]>();
  for (const t of sortTodos(items)) {
    const k = groupKeyOf(t, sessions, groupBy);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(t);
  }
  const keys = [...groups.keys()].sort();
  return (
    <div className="py-2">
      {keys.map((k) => (
        <div key={k} className="mb-2">
          {groupBy !== "none" && (
            <div className="px-3 pt-2 pb-1 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--t-dim)] flex items-center gap-2">
              <span className="truncate" title={k}>{groupBy === "folder" ? shortPath(k) : k}</span>
              <span className="ml-auto">{groups.get(k)!.filter((t) => t.status === "open").length}</span>
            </div>
          )}
          {groups.get(k)!.map((t) => <TodoRow key={t.id} t={t} sessions={sessions} now={now} patch={patch} />)}
        </div>
      ))}
    </div>
  );
}

/* ── board view (columns by priority) ── */
function BoardView({ items, sessions, now, patch }: ViewProps) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 p-3">
      {PRI_ORDER.map((p) => {
        const col = sortTodos(items.filter((t) => t.priority === p));
        return (
          <div key={p} className="flex flex-col min-h-0 rounded-lg border border-[var(--t-line)] bg-[var(--t-bg0)]/40">
            <div className="shrink-0 flex items-center gap-2 px-2.5 h-8 border-b border-[var(--t-line)]">
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: PRI_STYLE[p].color }} />
              <span className="text-[11px] font-medium text-[var(--t-fg2)] capitalize">{p}</span>
              <span className="ml-auto font-mono text-[10px] text-[var(--t-dim)]">{col.length}</span>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto t-scroll p-1.5 space-y-1.5">
              {col.length === 0 && <div className="px-2 py-4 text-center text-[10.5px] text-[var(--t-dim)]">—</div>}
              {col.map((t) => <TodoCard key={t.id} t={t} sessions={sessions} now={now} patch={patch} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── table view (sortable) ── */
function TableView({ items, sessions, now, patch }: ViewProps) {
  const [sort, setSort] = useState<{ col: string; dir: 1 | -1 }>({ col: "priority", dir: 1 });
  const val = (t: TodoItem, col: string): string | number => {
    const s = t.sessionId ? sessions[t.sessionId] : undefined;
    switch (col) {
      case "priority": return prioRank(t.priority);
      case "deadline": return t.deadline ?? Infinity;
      case "project": return s?.project ?? "";
      case "agent": return s?.harness ?? "user";
      case "folder": return s?.cwd ?? "";
      case "age": return -t.createdAt;
      default: return t.title.toLowerCase();
    }
  };
  const rows = [...items].sort((a, b) => {
    const va = val(a, sort.col);
    const vb = val(b, sort.col);
    return (va < vb ? -1 : va > vb ? 1 : 0) * sort.dir;
  });
  const TH = ({ col, children, right }: { col: string; children: React.ReactNode; right?: boolean }) => (
    <button onClick={() => setSort((s) => ({ col, dir: s.col === col ? (s.dir * -1) as 1 | -1 : 1 }))} className={cn("flex items-center gap-1 h-7 font-medium uppercase tracking-[0.08em] text-[var(--t-dim)] hover:text-[var(--t-mute)]", right && "justify-end")}>
      {children}{sort.col === col && <Icon name={sort.dir === 1 ? "down" : "chev"} size={9} className={sort.dir === -1 ? "rotate-180" : ""} />}
    </button>
  );
  return (
    <div className="px-2 py-1 min-w-[560px]">
      <div className="grid grid-cols-[24px_1fr_72px_96px_64px_80px_80px] gap-2 px-2 items-center border-b border-[var(--t-line)] text-[10px]">
        <span />
        <TH col="title">title</TH>
        <TH col="priority">priority</TH>
        <TH col="deadline">deadline</TH>
        <TH col="project">project</TH>
        <TH col="agent">agent</TH>
        <TH col="age" right>age</TH>
      </div>
      {rows.map((t) => <TodoTableRow key={t.id} t={t} sessions={sessions} now={now} patch={patch} />)}
    </div>
  );
}

/* ── calendar view (deadlines) ── */
function CalendarView({ items, now, patch }: ViewProps) {
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const byDay = new Map<string, TodoItem[]>();
  for (const t of items) {
    if (!t.deadline) continue;
    const d = new Date(t.deadline);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(t);
  }
  const first = new Date(month);
  const startWeekday = first.getDay();
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const today = new Date();
  const cells: (number | null)[] = [...Array<null>(startWeekday).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  return (
    <div className="p-3">
      <div className="flex items-center gap-2 mb-2">
        <Btn size="xs" variant="ghost" icon="chev" className="rotate-180" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} aria-label="Previous month" />
        <span className="text-[12.5px] text-[var(--t-fg)] font-medium">{month.toLocaleString(undefined, { month: "long", year: "numeric" })}</span>
        <Btn size="xs" variant="ghost" icon="chev" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} aria-label="Next month" />
        <span className="ml-auto text-[10.5px] text-[var(--t-dim)]">{items.filter((t) => !t.deadline && t.status === "open").length} undated open todos not shown</span>
      </div>
      <div className="grid grid-cols-7 gap-px rounded-lg overflow-hidden border border-[var(--t-line)] bg-[var(--t-line)]/50">
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          <div key={i} className="bg-[var(--t-bg0)] text-center text-[9.5px] font-mono uppercase text-[var(--t-dim)] py-1">{d}</div>
        ))}
        {cells.map((day, i) => {
          if (day === null) return <div key={i} className="bg-[var(--t-bg1)] min-h-[74px]" />;
          const key = `${month.getFullYear()}-${month.getMonth()}-${day}`;
          const dayTodos = byDay.get(key) ?? [];
          const isToday = today.getFullYear() === month.getFullYear() && today.getMonth() === month.getMonth() && today.getDate() === day;
          const past = new Date(month.getFullYear(), month.getMonth(), day + 1).getTime() < now;
          return (
            <div key={i} className={cn("bg-[var(--t-bg1)] min-h-[74px] p-1", isToday && "ring-1 ring-inset ring-[var(--t-amber)]/50")}>
              <div className={cn("text-[9.5px] font-mono mb-0.5", isToday ? "text-[var(--t-amber)] font-bold" : "text-[var(--t-dim)]")}>{day}</div>
              <div className="space-y-0.5">
                {dayTodos.slice(0, 3).map((t) => (
                  <button
                    key={t.id}
                    onClick={() => patch(t.id, { status: t.status === "open" ? "done" : "open" })}
                    title={`${t.title} — click to ${t.status === "open" ? "complete" : "reopen"}`}
                    className={cn(
                      "w-full text-left truncate rounded px-1 py-0.5 text-[10px] leading-tight",
                      t.status !== "open" ? "line-through text-[var(--t-dim)]" : past ? "bg-[var(--t-red)]/15 text-[var(--t-red)]" : "bg-[var(--t-bg2)] text-[var(--t-fg2)] hover:bg-[var(--t-bg0)]",
                    )}
                  >
                    {/* priority reads in-box (a dot), not as a side stripe */}
                    <span className="inline-block w-1 h-1 rounded-full mr-1 align-middle" style={{ background: PRI_STYLE[t.priority].color }} />
                    {t.title}
                  </button>
                ))}
                {dayTodos.length > 3 && <div className="text-[9px] text-[var(--t-dim)] px-1">+{dayTodos.length - 3} more</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── rows & cards ── */

interface ViewProps {
  items: TodoItem[];
  sessions: Record<string, { id: string; title: string; project?: string; cwd?: string; harness?: string; state?: string } | undefined>;
  now: number;
  patch: (id: string, p: Record<string, unknown>) => void;
}

function DeadlineChip({ t, now }: { t: TodoItem; now: number }) {
  if (!t.deadline) return null;
  const overdue = t.status === "open" && t.deadline < now;
  const today = new Date(t.deadline).toDateString() === new Date(now).toDateString();
  return (
    <span className={cn("shrink-0 font-mono text-[9.5px] px-1 rounded", overdue ? "bg-[var(--t-red)]/15 text-[var(--t-red)]" : today ? "bg-[var(--t-amber)]/15 text-[var(--t-amber)]" : "bg-[var(--t-bg2)] text-[var(--t-dim)]")} title={new Date(t.deadline).toLocaleString()}>
      {overdue ? "overdue " : ""}{new Date(t.deadline).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
    </span>
  );
}

function SubtaskBar({ t, patch }: { t: TodoItem; patch: ViewProps["patch"] }) {
  if (!t.subtasks.length) return null;
  const done = t.subtasks.filter((s) => s.done).length;
  return (
    <button
      className="shrink-0 flex items-center gap-1 group"
      title={`subtasks: ${done}/${t.subtasks.length}\n${t.subtasks.map((s) => `${s.done ? "☑" : "☐"} ${s.text}`).join("\n")}\n(click to toggle the next open one)`}
      onClick={() => {
        const nextOpen = t.subtasks.find((s) => !s.done);
        const subtasks = nextOpen ? t.subtasks.map((s) => (s.id === nextOpen.id ? { ...s, done: true } : s)) : t.subtasks.map((s) => ({ ...s, done: false }));
        patch(t.id, { subtasks });
      }}
    >
      <span className="w-12 h-1 rounded-full bg-[var(--t-line)] overflow-hidden"><span className="block h-full bg-[var(--t-teal)]" style={{ width: `${(done / t.subtasks.length) * 100}%` }} /></span>
      <span className="font-mono text-[9.5px] text-[var(--t-dim)] group-hover:text-[var(--t-mute)]">{done}/{t.subtasks.length}</span>
    </button>
  );
}

function TodoRow({ t, sessions, now, patch }: { t: TodoItem } & Omit<ViewProps, "items">) {
  const [open, setOpen] = useState(false);
  const s = t.sessionId ? sessions[t.sessionId] : undefined;
  return (
    <div className={cn("group border-b border-[var(--t-line)]/40 hover:bg-white/[0.02]", t.status !== "open" && "opacity-55")}>
      <div className="flex items-center gap-2 px-3 py-1.5">
        <button
          role="checkbox"
          aria-checked={t.status !== "open"}
          aria-label={t.status === "open" ? `Mark done: ${t.title}` : `Reopen: ${t.title}`}
          onClick={() => patch(t.id, { status: t.status === "open" ? "done" : "open" })}
          className={cn("w-4 h-4 rounded-full border grid place-items-center shrink-0", t.status === "open" ? "border-[var(--t-line2)] hover:border-[var(--t-teal)]" : "border-[var(--t-teal)] bg-[var(--t-teal)]/20 text-[var(--t-teal)]")}
        >
          {t.status !== "open" && <Icon name="check" size={9} />}
        </button>
        <button onClick={() => setOpen((v) => !v)} className="min-w-0 flex-1 text-left">
          <span className={cn("text-[12.5px]", t.status === "open" ? "text-[var(--t-fg)]" : "line-through text-[var(--t-dim)]")}>{t.title}</span>
        </button>
        <span className="shrink-0 font-mono text-[9.5px] px-1 rounded capitalize" style={{ color: PRI_STYLE[t.priority].color, background: `color-mix(in oklab, ${PRI_STYLE[t.priority].color} 12%, transparent)` }}>{t.priority}</span>
        <DeadlineChip t={t} now={now} />
        {t.estimate && <span className="shrink-0 font-mono text-[9.5px] text-[var(--t-dim)]" title="agent's effort estimate">{t.estimate}</span>}
        <SubtaskBar t={t} patch={patch} />
        {s && (
          <button onClick={() => openPanel("chat", { sessionId: s.id })} className="shrink-0 opacity-0 group-hover:opacity-70 hover:!opacity-100 text-[var(--t-dim)] hover:text-[var(--t-fg)]" title={`filed by ${s.title} — open the session`}>
            <Icon name="chat" size={11} />
          </button>
        )}
        <span className="shrink-0 font-mono text-[9.5px] text-[var(--t-dim)] tabular-nums w-12 text-right">{ago(t.updatedAt, now)}</span>
      </div>
      {open && <TodoEditor t={t} patch={patch} onClose={() => setOpen(false)} />}
    </div>
  );
}

function TodoCard({ t, sessions, now, patch }: { t: TodoItem } & Omit<ViewProps, "items">) {
  const [open, setOpen] = useState(false);
  const s = t.sessionId ? sessions[t.sessionId] : undefined;
  return (
    <div className={cn("rounded-md border border-[var(--t-line)] bg-[var(--t-bg1)] px-2.5 py-2", t.status !== "open" && "opacity-55")}>
      <div className="flex items-start gap-1.5">
        <button
          role="checkbox"
          aria-checked={t.status !== "open"}
          onClick={() => patch(t.id, { status: t.status === "open" ? "done" : "open" })}
          className={cn("mt-0.5 w-3.5 h-3.5 rounded-full border grid place-items-center shrink-0", t.status === "open" ? "border-[var(--t-line2)] hover:border-[var(--t-teal)]" : "border-[var(--t-teal)] bg-[var(--t-teal)]/20 text-[var(--t-teal)]")}
          aria-label={t.status === "open" ? "Mark done" : "Reopen"}
        >
          {t.status !== "open" && <Icon name="check" size={8} />}
        </button>
        <button onClick={() => setOpen((v) => !v)} className="min-w-0 flex-1 text-left text-[12px] text-[var(--t-fg)] leading-snug">{t.title}</button>
      </div>
      <div className="mt-1.5 flex items-center gap-1 flex-wrap">
        <DeadlineChip t={t} now={now} />
        {t.labels.slice(0, 3).map((l) => <span key={l} className="font-mono text-[9px] px-1 rounded bg-[var(--t-bg2)] text-[var(--t-mute)]">{l}</span>)}
        <span className="ml-auto" />
        {s && <button onClick={() => openPanel("chat", { sessionId: s.id })} className="text-[var(--t-dim)] hover:text-[var(--t-fg)]" title={`filed by ${s.title}`}><Icon name="chat" size={10} /></button>}
      </div>
      {open && <TodoEditor t={t} patch={patch} onClose={() => setOpen(false)} />}
    </div>
  );
}

function TodoTableRow({ t, sessions, now, patch }: { t: TodoItem } & Omit<ViewProps, "items">) {
  const [open, setOpen] = useState(false);
  const s = t.sessionId ? sessions[t.sessionId] : undefined;
  return (
    <>
      <div className={cn("grid grid-cols-[24px_1fr_72px_96px_64px_80px_80px] gap-2 px-2 items-center border-b border-[var(--t-line)]/40 hover:bg-white/[0.02] text-[11.5px]", t.status !== "open" && "opacity-55")}>
        <button role="checkbox" aria-checked={t.status !== "open"} onClick={() => patch(t.id, { status: t.status === "open" ? "done" : "open" })} className={cn("w-3.5 h-3.5 rounded-full border grid place-items-center", t.status === "open" ? "border-[var(--t-line2)]" : "border-[var(--t-teal)] bg-[var(--t-teal)]/20 text-[var(--t-teal)]")} aria-label="Toggle done">
          {t.status !== "open" && <Icon name="check" size={8} />}
        </button>
        <button onClick={() => setOpen((v) => !v)} className="truncate text-left text-[var(--t-fg2)]" title={t.title}>{t.title}</button>
        <span className="font-mono text-[10px] capitalize" style={{ color: PRI_STYLE[t.priority].color }}>{t.priority}</span>
        <DeadlineChip t={t} now={now} />
        <span className="truncate font-mono text-[10px] text-[var(--t-dim)]">{s?.project ?? "—"}</span>
        <span className="truncate font-mono text-[10px] text-[var(--t-dim)]">{s?.harness ?? "user"}</span>
        <span className="text-right font-mono text-[10px] text-[var(--t-dim)] tabular-nums">{ago(t.createdAt, now)}</span>
      </div>
      {open && <TodoEditor t={t} patch={patch} onClose={() => setOpen(false)} />}
    </>
  );
}

/* ── inline editor (the user may edit everything) ── */
function TodoEditor({ t, patch, onClose }: { t: TodoItem; patch: ViewProps["patch"]; onClose: () => void }) {
  const [f, setF] = useState({
    title: t.title,
    notes: t.notes,
    priority: t.priority,
    deadline: t.deadline ? new Date(t.deadline).toISOString().slice(0, 10) : "",
    estimate: t.estimate ?? "",
    labels: t.labels.join(", "),
    status: t.status,
  });
  const [newSub, setNewSub] = useState("");
  const save = () => {
    patch(t.id, {
      title: f.title.trim() || t.title,
      notes: f.notes,
      priority: f.priority,
      deadline: f.deadline ? new Date(f.deadline + "T23:59:59").getTime() : null,
      estimate: f.estimate.trim() || null,
      labels: f.labels.split(",").map((l) => l.trim()).filter(Boolean),
      status: f.status,
    });
    onClose();
  };
  return (
    <div className="mx-3 mb-2 rounded-lg border border-[var(--t-line2)] bg-[var(--t-bg2)] p-3 space-y-2">
      <input className="t-input w-full" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
      <textarea className="t-input w-full resize-y font-mono text-[11.5px]" rows={3} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="notes (markdown-ish)" />
      <div className="flex items-center gap-2 flex-wrap">
        <Select width={104} ariaLabel="Priority" value={f.priority} onChange={(v) => setF({ ...f, priority: v as TodoPriority })} options={PRI_ORDER.map((p) => ({ value: p, label: p }))} />
        <Select width={110} ariaLabel="Status" value={f.status} onChange={(v) => setF({ ...f, status: v as TodoItem["status"] })} options={[{ value: "open", label: "open" }, { value: "done", label: "done" }, { value: "dropped", label: "dropped" }]} />
        <input type="date" className="t-input w-34 font-mono text-[11px]" value={f.deadline} onChange={(e) => setF({ ...f, deadline: e.target.value })} title="Deadline" />
        <input className="t-input w-20" value={f.estimate} onChange={(e) => setF({ ...f, estimate: e.target.value })} placeholder="est. (2m, S)" title="Estimate" />
        <input className="t-input flex-1 min-w-28" value={f.labels} onChange={(e) => setF({ ...f, labels: e.target.value })} placeholder="labels, comma-sep" />
      </div>
      {/* subtasks */}
      <div>
        {t.subtasks.map((sub) => (
          <label key={sub.id} className="flex items-center gap-2 h-6 text-[11.5px] text-[var(--t-fg2)] cursor-pointer">
            <input
              type="checkbox"
              checked={sub.done}
              onChange={() => patch(t.id, { subtasks: t.subtasks.map((x) => (x.id === sub.id ? { ...x, done: !x.done } : x)) })}
              className="accent-[var(--t-teal)]"
            />
            <span className={sub.done ? "line-through text-[var(--t-dim)]" : ""}>{sub.text}</span>
          </label>
        ))}
        <div className="flex items-center gap-2 mt-1">
          <input className="t-input flex-1 h-7 text-[11.5px]" value={newSub} onChange={(e) => setNewSub(e.target.value)} onKeyDown={(e) => {
            if (e.key === "Enter" && newSub.trim()) {
              const subtasks: TodoSubtask[] = [...t.subtasks, { id: Math.random().toString(36).slice(2, 7), text: newSub.trim(), done: false }];
              patch(t.id, { subtasks });
              setNewSub("");
            }
          }} placeholder="add a subtask (Enter)" />
        </div>
      </div>
      {Object.keys(t.meta).length > 0 && (
        <div className="font-mono text-[10px] text-[var(--t-dim)]">agent fields: {Object.entries(t.meta).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join("  ")}</div>
      )}
      <div className="flex justify-end gap-2">
        <Btn size="xs" variant="ghost" onClick={onClose}>Close</Btn>
        <Btn size="xs" variant="amber" onClick={save}>Save</Btn>
      </div>
    </div>
  );
}
