import { useCallback, useEffect, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { store, useApp, useNow } from "@/lib/store";
import { useDesktops } from "@/lib/desktops";
import { ago, harnessStyle, shortPath } from "@/lib/format";
import { harnessDisplay, hostAliases } from "@/lib/device";
import { Btn, Empty, HarnessMark, Icon, Select, Spinner } from "@/components/ui";
import { openPanel } from "@/lib/workspace";
import type { TaskInfo, TaskStatus } from "@/lib/proto";
import { cn } from "@/utils/cn";

type P = { sessionId?: string; cwd?: string };

const COLS: { id: TaskStatus; label: string; color: string }[] = [
  { id: "todo", label: "To do", color: "var(--t-dim)" },
  { id: "doing", label: "Running", color: "var(--t-amber)" },
  { id: "done", label: "Done", color: "var(--t-teal)" },
];

/**
 * Tasks — a persistent kanban of agent tasks (lean clone of the dsh-lab
 * task-board plugin). Cards pin a harness + working directory; "Run" spawns a
 * real session and sends the prompt, and the card links to it. Agents can
 * file cards themselves through the mcp__truss__ task tools. No cron in v1.
 */
export function TasksPanel({ params }: IDockviewPanelProps<P>) {
  const backend = useApp((s) => s.backend);
  const harnesses = useApp((s) => s.harnesses);
  const hosts = useApp((s) => s.hosts);
  const hostPrefs = useDesktops((s) => s.hosts);
  const sessions = useApp((s) => s.sessions);
  const focus = useApp((s) => (params.sessionId ? s.sessions[params.sessionId] : s.focused ? s.sessions[s.focused] : undefined));
  const [tasks, setTasks] = useState<TaskInfo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({ title: "", prompt: "", cwd: "", harness: "" });
  const now = useNow(30_000);

  const load = useCallback(() => {
    if (!backend) return;
    backend.tasks().then(
      (r) => setTasks(r.tasks),
      (e) => setErr(e.message ?? String(e)),
    );
  }, [backend]);

  useEffect(() => {
    load();
    /* live-ish refresh: a run linking a session bumps updated_at on the
       session row; poll lightly while the panel is open */
    const t = window.setInterval(load, 15_000);
    return () => window.clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (creating && !form.cwd && focus) setForm((f) => ({ ...f, cwd: focus.cwd, harness: f.harness || focus.harness }));
  }, [creating, focus]);

  const act = async (id: string, fn: () => Promise<unknown>, flag = id) => {
    setBusy(flag);
    setErr(null);
    try {
      await fn();
      load();
    } catch (e: any) {
      setErr(e.message ?? String(e));
    } finally {
      setBusy(null);
    }
  };

  const submit = async () => {
    if (!backend || !form.title.trim() || !form.cwd.trim() || !form.harness) return;
    setBusy("new");
    try {
      await backend.createTask({ title: form.title.trim(), prompt: form.prompt, cwd: form.cwd.trim(), harness: form.harness });
      setCreating(false);
      setForm({ title: "", prompt: "", cwd: focus?.cwd ?? "", harness: focus?.harness ?? "" });
      load();
    } catch (e: any) {
      setErr(e.message ?? String(e));
    } finally {
      setBusy(null);
    }
  };

  const byStatus = (s: TaskStatus) => (tasks ?? []).filter((t) => t.status === s);
  const archived = byStatus("archived");

  return (
    <div className="h-full flex flex-col bg-[var(--t-bg1)] t-panel">
      <div className="shrink-0 flex items-center gap-2 px-3 h-9 border-b border-[var(--t-line)]">
        <Icon name="check" size={13} className="text-[var(--t-teal)]" />
        <span className="text-[12px] text-[var(--t-fg)] font-medium">Task board</span>
        {tasks && <span className="font-mono text-[10px] text-[var(--t-dim)]">{byStatus("todo").length + byStatus("doing").length} open</span>}
        <span className="ml-auto flex items-center gap-1">
          <Btn size="xs" variant="ghost" onClick={() => setShowArchived((v) => !v)} title="Show archived cards">{showArchived ? "Hide archived" : "Archived"}</Btn>
          <Btn size="xs" variant="ghost" icon="retry" title="Refresh" onClick={load} />
          <Btn size="xs" variant="outline" icon="plus" onClick={() => setCreating((v) => !v)}>New task</Btn>
        </span>
      </div>

      {creating && (
        <div className="shrink-0 border-b border-[var(--t-line)] bg-[var(--t-bg2)] px-3 py-2.5 space-y-2">
          <input
            autoFocus
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder="Task title — e.g. “port the auth tests to vitest”"
            className="t-input w-full"
          />
          <textarea
            value={form.prompt}
            onChange={(e) => setForm({ ...form, prompt: e.target.value })}
            placeholder="Prompt the agent runs (optional until Run)…"
            rows={3}
            className="t-input w-full resize-y font-mono text-[11.5px]"
          />
          <div className="flex items-center gap-2">
            <input
              value={form.cwd}
              onChange={(e) => setForm({ ...form, cwd: e.target.value })}
              placeholder="working directory"
              className="t-input flex-1 font-mono text-[11.5px]"
            />
            <Select
              value={form.harness}
              onChange={(v) => setForm({ ...form, harness: v })}
              ariaLabel="Harness"
              width={150}
              options={harnesses.map((h) => ({ value: h.id, label: harnessDisplay(h.id, hosts, hostAliases(hostPrefs)) }))}
            />
            <Btn size="xs" variant="amber" disabled={busy === "new" || !form.title.trim() || !form.cwd.trim() || !form.harness} onClick={() => void submit()}>Add card</Btn>
            <Btn size="xs" variant="ghost" onClick={() => setCreating(false)}>Cancel</Btn>
          </div>
        </div>
      )}
      {err && (
        <div className="shrink-0 px-3 py-1.5 border-b border-[var(--t-line)] text-[11px] font-mono text-[var(--t-red)] flex items-center gap-2">
          <span className="flex-1 truncate">{err}</span>
          <button onClick={() => setErr(null)} aria-label="Dismiss"><Icon name="x" size={11} /></button>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto t-scroll">
        {!tasks ? (
          <div className="h-full grid place-items-center"><Spinner /></div>
        ) : tasks.length === 0 ? (
          <Empty icon="check" title="No tasks yet">
            File a card with “New task”, or ask a running agent to file one — agents see <span className="font-mono">mcp__truss__create_task</span>.
          </Empty>
        ) : (
          <div className={cn("grid gap-2 p-3", showArchived ? "grid-cols-2 lg:grid-cols-4" : "grid-cols-1 md:grid-cols-3")}>
            {COLS.map((col) => (
              <Column key={col.id} col={col} tasks={byStatus(col.id)} busy={busy} now={now} sessions={sessions} act={act} />
            ))}
            {showArchived && (
              <Column col={{ id: "archived", label: "Archived", color: "var(--t-dim)" }} tasks={archived} busy={busy} now={now} sessions={sessions} act={act} archived />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Column({ col, tasks, busy, now, sessions, act, archived }: {
  col: { id: TaskStatus; label: string; color: string };
  tasks: TaskInfo[];
  busy: string | null;
  now: number;
  sessions: Record<string, { title: string; state: string } | undefined>;
  act: (id: string, fn: () => Promise<unknown>, flag?: string) => Promise<void>;
  archived?: boolean;
}) {
  const backend = store.be;
  return (
    <div className="flex flex-col min-h-0 rounded-lg border border-[var(--t-line)] bg-[var(--t-bg0)]/40">
      <div className="shrink-0 flex items-center gap-2 px-2.5 h-8 border-b border-[var(--t-line)]">
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: col.color }} />
        <span className="text-[11px] font-medium text-[var(--t-fg2)]">{col.label}</span>
        <span className="ml-auto font-mono text-[10px] text-[var(--t-dim)]">{tasks.length}</span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto t-scroll p-1.5 space-y-1.5">
        {tasks.length === 0 && <div className="px-2 py-4 text-center text-[10.5px] text-[var(--t-dim)]">—</div>}
        {tasks.map((t) => {
          const linked = t.sessionId ? sessions[t.sessionId] : undefined;
          return (
            <div key={t.id} className="group rounded-md border border-[var(--t-line)] bg-[var(--t-bg1)] px-2.5 py-2 hover:border-[var(--t-line2)]">
              <div className="flex items-start gap-1.5">
                <span className="mt-px shrink-0" style={{ color: harnessStyle(t.harness).color }}><HarnessMark harness={t.harness} size={13} /></span>
                <span className="min-w-0 flex-1 text-[12px] text-[var(--t-fg)] leading-snug">{t.title}</span>
              </div>
              {t.prompt && <div className="mt-1 font-mono text-[10.5px] text-[var(--t-dim)] leading-snug line-clamp-2 whitespace-pre-wrap">{t.prompt}</div>}
              <div className="mt-1.5 flex items-center gap-1 text-[10px] font-mono text-[var(--t-dim)]">
                <span className="truncate" title={t.cwd}>{shortPath(t.cwd)}</span>
                <span className="ml-auto shrink-0 tabular-nums">{t.lastRunAt ? `ran ${ago(t.lastRunAt, now)}` : ago(t.updatedAt, now)}</span>
              </div>
              <div className="mt-1.5 flex items-center gap-1">
                {col.id === "todo" && (
                  <Btn size="xs" variant="amber" icon="send" disabled={!t.prompt.trim() || busy === t.id} title={t.prompt.trim() ? "Run this task as a new session" : "Add a prompt first"} onClick={() => act(t.id, async () => {
                    const r = await backend!.runTask(t.id);
                    openPanel("chat", { sessionId: r.session.id });
                  })}>Run</Btn>
                )}
                {t.sessionId && (
                  <Btn size="xs" variant="outline" icon="chat" title="Open the linked session" onClick={() => openPanel("chat", { sessionId: t.sessionId! })}>
                    {linked ? "Open run" : "Open run (closed)"}
                  </Btn>
                )}
                <span className="ml-auto" />
                {col.id === "doing" && (
                  <CardBtn icon="check" label="Mark done" onClick={() => act(t.id, () => backend!.updateTask(t.id, { status: "done" }))} />
                )}
                {col.id === "done" && (
                  <CardBtn icon="retry" label="Move back to todo" onClick={() => act(t.id, () => backend!.updateTask(t.id, { status: "todo" }))} />
                )}
                {!archived && col.id !== "doing" && (
                  <CardBtn icon="archive" label="Archive" onClick={() => act(t.id, () => backend!.updateTask(t.id, { status: "archived" }))} />
                )}
                {archived && (
                  <>
                    <CardBtn icon="retry" label="Restore to todo" onClick={() => act(t.id, () => backend!.updateTask(t.id, { status: "todo" }))} />
                    <CardBtn icon="trash" label="Delete permanently" dangerous onClick={() => act(t.id, () => backend!.deleteTask(t.id))} />
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CardBtn({ icon, label, onClick, dangerous }: { icon: string; label: string; onClick: () => void; dangerous?: boolean }) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "w-5 h-5 grid place-items-center rounded opacity-0 group-hover:opacity-60 focus:opacity-100 hover:!opacity-100 hover:bg-white/10",
        dangerous ? "text-[var(--t-red)]" : "text-[var(--t-mute)]",
      )}
    >
      <Icon name={icon} size={11} />
    </button>
  );
}
