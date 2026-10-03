import { useMemo, useRef, useState } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { createPortal } from "react-dom";
import { store, useApp, useNow } from "@/lib/store";
import { ago } from "@/lib/format";
import { Btn, Empty, HarnessMark, Icon, Select, Spinner } from "@/components/ui";
import { openPanel } from "@/lib/workspace";
import { Markdown } from "./Markdown";
import type { FeedItem, FeedState, FeedType } from "@/lib/proto";
import { cn } from "@/utils/cn";

/**
 * Feed — the unified inbox. Permission decisions (actionable), agent-filed
 * todos, finished work, task-board runs, errors, context pressure, and agent
 * reports. Cards persist until you read / save / dismiss / do them. Share
 * sends a card into another agent's chat AND exposes it to that session's
 * list_feed tool.
 */

const TYPE_META: Record<FeedType, { icon: string; color: string; label: string }> = {
  todo: { icon: "check", color: "var(--t-teal)", label: "todo" },
  permission: { icon: "lock", color: "var(--t-amber)", label: "decision" },
  work_done: { icon: "check", color: "var(--t-sky)", label: "finished" },
  task_run: { icon: "send", color: "var(--t-violet)", label: "task run" },
  error: { icon: "alert", color: "var(--t-red)", label: "error" },
  context: { icon: "gauge", color: "var(--t-coral)", label: "context" },
  report: { icon: "wave", color: "var(--t-amber)", label: "report" },
  note: { icon: "chat", color: "var(--t-mute)", label: "note" },
  doubletake: { icon: "brain", color: "var(--t-violet)", label: "research" },
};

const IMPORTANCE_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

export function FeedPanel(_props: IDockviewPanelProps) {
  const feed = useApp((s) => s.feed);
  const loaded = useApp((s) => s.feedLoaded);
  const sessions = useApp((s) => s.sessions);
  const now = useNow(30_000);
  const [sort, setSort] = useState<"recent" | "importance">("recent");
  const [types, setTypes] = useState<Set<FeedType>>(new Set());
  const [stateFilter, setStateFilter] = useState<"inbox" | "unread" | "saved" | "done" | "dismissed" | "all">("inbox");
  const [q, setQ] = useState("");

  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let list = Object.values(feed);
    if (stateFilter === "inbox") list = list.filter((i) => i.state === "unread" || i.state === "read");
    else if (stateFilter !== "all") list = list.filter((i) => i.state === stateFilter);
    if (types.size) list = list.filter((i) => types.has(i.type));
    if (needle) list = list.filter((i) => `${i.title} ${i.body}`.toLowerCase().includes(needle));
    list.sort((a, b) =>
      sort === "importance"
        ? (IMPORTANCE_RANK[a.importance] - IMPORTANCE_RANK[b.importance]) || b.createdAt - a.createdAt
        : b.createdAt - a.createdAt,
    );
    return list;
  }, [feed, sort, types, stateFilter, q]);

  const unread = Object.values(feed).filter((i) => i.state === "unread").length;
  const setState = (id: string, state: FeedState) => void store.be?.setFeedState(id, state).catch((e) => store.toast("error", "Feed update failed", e.message));
  const markAllRead = () => {
    for (const i of Object.values(feed)) if (i.state === "unread") void store.be?.setFeedState(i.id, "read").catch(() => {});
  };

  if (!loaded) return <div className="h-full grid place-items-center bg-[var(--t-bg1)]"><Spinner /></div>;

  return (
    <div className="h-full flex flex-col bg-[var(--t-bg1)] t-panel">
      <div className="shrink-0 flex items-center gap-2 px-3 h-9 border-b border-[var(--t-line)]">
        <Icon name="bolt" size={13} className="text-[var(--t-amber)]" />
        <span className="text-[12px] text-[var(--t-fg)] font-medium">Feed</span>
        {unread > 0 && <span className="min-w-4 h-4 px-1 rounded-full bg-[var(--t-amber)] text-[#1b1305] text-[9.5px] font-bold grid place-items-center">{unread}</span>}
        <div className="ml-auto flex items-center gap-1.5">
          <div className="flex items-center gap-1.5 h-6 px-2 rounded bg-[var(--t-bg0)] border border-[var(--t-line)]">
            <Icon name="search" size={10} className="text-[var(--t-dim)]" />
            <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQ("")} placeholder="search" className="w-24 bg-transparent text-[11.5px] outline-none text-[var(--t-fg)] placeholder:text-[var(--t-dim)]" />
          </div>
          <Select size="bar" width={118} ariaLabel="Sort" value={sort} onChange={(v) => setSort(v as never)} options={[{ value: "recent", label: "most recent" }, { value: "importance", label: "importance" }]} />
          <Select size="bar" width={104} ariaLabel="State" value={stateFilter} onChange={(v) => setStateFilter(v as never)} options={[
            { value: "inbox", label: "inbox" }, { value: "unread", label: "unread" }, { value: "saved", label: "saved" },
            { value: "done", label: "done" }, { value: "dismissed", label: "dismissed" }, { value: "all", label: "all" },
          ]} />
          <Btn size="xs" variant="ghost" onClick={markAllRead} title="Mark every card read">Read all</Btn>
        </div>
      </div>

      {/* type filter chips */}
      <div className="shrink-0 flex items-center gap-1 px-3 py-1.5 border-b border-[var(--t-line)] flex-wrap">
        {(Object.keys(TYPE_META) as FeedType[]).map((t) => {
          const on = types.has(t);
          return (
            <button
              key={t}
              onClick={() => setTypes((s) => { const n = new Set(s); if (n.has(t)) n.delete(t); else n.add(t); return n; })}
              className={cn("flex items-center gap-1 h-5.5 px-2 rounded-full text-[10px] font-mono border", on ? "border-[var(--t-line2)] bg-white/[0.07] text-[var(--t-fg)]" : "border-[var(--t-line)] text-[var(--t-dim)] hover:text-[var(--t-mute)]")}
            >
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: TYPE_META[t].color }} />
              {TYPE_META[t].label}
            </button>
          );
        })}
        {types.size > 0 && <button onClick={() => setTypes(new Set())} className="text-[10px] text-[var(--t-dim)] hover:text-[var(--t-fg)] px-1">clear</button>}
      </div>

      <div className="flex-1 min-h-0 overflow-auto t-scroll p-3 space-y-2">
        {items.length === 0 ? (
          <Empty icon="bolt" title="Inbox zero">{stateFilter === "inbox" ? "Nothing waiting. Agents post reports and file decisions here." : "Nothing matches these filters."}</Empty>
        ) : (
          items.map((item) => <FeedCard key={item.id} item={item} sessions={sessions} now={now} setState={setState} />)
        )}
      </div>
    </div>
  );
}

/* ── one card ── */
function FeedCard({ item, sessions, now, setState }: {
  item: FeedItem;
  sessions: Record<string, { id: string; title: string; harness: string } | undefined>;
  now: number;
  setState: (id: string, state: FeedState) => void;
}) {
  const [open, setOpen] = useState(item.state === "unread" && item.importance !== "low");
  const [shareOpen, setShareOpen] = useState(false);
  const shareRef = useRef<HTMLButtonElement>(null);
  const meta = TYPE_META[item.type] ?? TYPE_META.note;
  const s = item.sessionId ? sessions[item.sessionId] : undefined;
  const unread = item.state === "unread";
  const data = item.data as Record<string, any>;

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e: any) {
      store.toast("error", "Action failed", e?.message ?? String(e));
    }
  };

  return (
    <div
      className={cn("rounded-lg border bg-[var(--t-bg0)]/60 transition-colors", unread ? "border-[var(--t-line2)]" : "border-[var(--t-line)] opacity-80")}
    >
      <div className="flex items-center gap-2 px-3 pt-2">
        {/* type reads inside the box: tinted icon chip + colored label */}
        <span className="w-5 h-5 rounded-[5px] grid place-items-center shrink-0" style={{ color: meta.color, background: `color-mix(in oklab, ${meta.color} 14%, transparent)` }}>
          <Icon name={meta.icon} size={11} />
        </span>
        <span className="font-mono text-[9.5px] uppercase tracking-wider" style={{ color: meta.color }}>{meta.label}</span>
        {item.importance !== "normal" && item.importance !== "low" && (
          <span className={cn("font-mono text-[9px] px-1 rounded capitalize", item.importance === "urgent" ? "bg-[var(--t-red)]/15 text-[var(--t-red)]" : "bg-[var(--t-amber)]/15 text-[var(--t-amber)]")}>{item.importance}</span>
        )}
        {item.state === "saved" && <Icon name="tag" size={10} className="text-[var(--t-sky)]" />}
        <span className="ml-auto font-mono text-[9.5px] text-[var(--t-dim)] tabular-nums">{ago(item.createdAt, now)}</span>
      </div>
      <button onClick={() => setOpen((v) => !v)} className="w-full text-left px-3 pt-1 pb-1.5">
        <span className={cn("text-[12.5px] leading-snug", unread ? "text-[var(--t-fg)] font-medium" : "text-[var(--t-fg2)]")}>{item.title}</span>
      </button>

      {open && (
        <div className="px-3 pb-2">
          {item.body && <div className="t-md text-[12px] text-[var(--t-fg2)] mb-2"><Markdown text={item.body} /></div>}

          {/* type-specific actions */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {item.type === "permission" && s && Array.isArray(data.options) && item.state !== "done" && (
              (data.options as string[]).map((opt) => (
                <Btn
                  key={opt}
                  size="xs"
                  variant={/allow|approve|yes|once/i.test(opt) ? "amber" : "outline"}
                  onClick={() => act(async () => {
                    await store.be!.permission(item.sessionId!, String(data.requestId), opt);
                    setState(item.id, "done");
                  })}
                >
                  {opt}
                </Btn>
              ))
            )}
            {item.type === "todo" && data.accessRequest && item.state !== "done" && (
              <>
                <Btn size="xs" variant="amber" onClick={() => act(async () => {
                  await store.be!.resolveTodoAccess(String(data.todoId), String(data.requesterId), true);
                  setState(item.id, "done");
                })}>Allow edits</Btn>
                <Btn size="xs" variant="outline" onClick={() => act(async () => {
                  await store.be!.resolveTodoAccess(String(data.todoId), String(data.requesterId), false);
                  setState(item.id, "done");
                })}>Deny</Btn>
              </>
            )}
            {item.type === "todo" && !data.accessRequest && data.todoId && (
              <TodoQuickAction todoId={String(data.todoId)} onDone={() => setState(item.id, "done")} />
            )}
            {item.type === "doubletake" && typeof data.chatUrl === "string" && (
              <Btn size="xs" variant="outline" icon="brain" onClick={() => window.open(data.chatUrl, "_blank", "noopener,noreferrer")}>Open in doubletake</Btn>
            )}
            {s && (
              <Btn size="xs" variant="ghost" icon="chat" onClick={() => openPanel("chat", { sessionId: s.id })}>Open session</Btn>
            )}
            <span className="ml-auto" />
            {/* universal actions */}
            <CardAction icon="check" label={unread ? "Mark read" : "Mark unread"} onClick={() => setState(item.id, unread ? "read" : "unread")} />
            <CardAction icon="tag" label={item.state === "saved" ? "Unsave" : "Save"} active={item.state === "saved"} onClick={() => setState(item.id, item.state === "saved" ? "read" : "saved")} />
            <button ref={shareRef} onClick={() => setShareOpen((v) => !v)} className="w-6 h-6 grid place-items-center rounded text-[var(--t-dim)] hover:text-[var(--t-fg)] hover:bg-white/5" title="Share to another agent's session" aria-label="Share">
              <Icon name="send" size={11} />
            </button>
            <CardAction icon="x" label="Dismiss" onClick={() => setState(item.id, "dismissed")} />
          </div>
          {item.sharedWith.length > 0 && (
            <div className="mt-1.5 font-mono text-[9.5px] text-[var(--t-dim)]">shared with {item.sharedWith.map((id) => sessions[id]?.title ?? id).join(", ")}</div>
          )}
        </div>
      )}
      {shareOpen && shareRef.current && <SharePop anchor={shareRef.current} item={item} onClose={() => setShareOpen(false)} />}
    </div>
  );
}

function TodoQuickAction({ todoId, onDone }: { todoId: string; onDone: () => void }) {
  const todo = useApp((s) => s.todos[todoId]);
  if (!todo) return null;
  return (
    <>
      <Btn size="xs" variant={todo.status === "open" ? "amber" : "outline"} icon="check" onClick={() => void store.be?.updateTodo(todoId, { status: todo.status === "open" ? "done" : "open" }).then(onDone).catch((e) => store.toast("error", "Couldn't update the todo", e.message))}>
        {todo.status === "open" ? "Mark done" : "Reopen"}
      </Btn>
      <Btn size="xs" variant="ghost" onClick={() => openPanel("todos")}>Open in Todos</Btn>
    </>
  );
}

function CardAction({ icon, label, onClick, active }: { icon: string; label: string; onClick: () => void; active?: boolean }) {
  return (
    <button onClick={onClick} title={label} aria-label={label} className={cn("w-6 h-6 grid place-items-center rounded hover:bg-white/5", active ? "text-[var(--t-sky)]" : "text-[var(--t-dim)] hover:text-[var(--t-fg)]")}>
      <Icon name={icon} size={11} />
    </button>
  );
}

/* share popover: pick a session → chat message + agent-visible share */
function SharePop({ anchor, item, onClose }: { anchor: HTMLElement; item: FeedItem; onClose: () => void }) {
  const order = useApp((s) => s.order);
  const sessions = useApp((s) => s.sessions);
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const [pos] = useState(() => {
    const r = anchor.getBoundingClientRect();
    return { left: Math.max(8, Math.min(r.right - 260, window.innerWidth - 268)), top: Math.min(r.bottom + 6, window.innerHeight - 300) };
  });
  const list = order.map((id) => sessions[id]).filter(Boolean).filter((s) => !item.sharedWith.includes(s.id) && (!q || s.title.toLowerCase().includes(q.toLowerCase()))).slice(0, 8);
  return createPortal(
    <>
      <div className="fixed inset-0 z-[170]" onPointerDown={onClose} />
      <div role="dialog" aria-label="Share to session" className="fixed z-[171] w-[260px] rounded-lg border border-[var(--t-line2)] bg-[var(--t-bg2)] shadow-2xl t-pop overflow-hidden" style={pos}>
        <div className="flex items-center gap-2 px-3 h-9 border-b border-[var(--t-line)]">
          <Icon name="search" size={11} className="text-[var(--t-dim)]" />
          <input ref={input} autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="share to session…" className="flex-1 bg-transparent outline-none text-[12px] text-[var(--t-fg)] placeholder:text-[var(--t-dim)]" />
        </div>
        <div className="max-h-[240px] overflow-y-auto t-scroll py-1">
          {list.length === 0 && <div className="px-3 py-4 text-center text-[11px] text-[var(--t-dim)]">No sessions to share to.</div>}
          {list.map((s) => (
            <button
              key={s.id}
              onClick={() => {
                onClose();
                void store.be?.shareFeed(item.id, s.id).then(
                  () => store.toast("ok", "Shared", `sent to ${s.title}`),
                  (e) => store.toast("error", "Share failed", e.message),
                );
              }}
              className="w-full flex items-center gap-2 px-3 h-8 text-left hover:bg-white/[0.05]"
            >
              <HarnessMark harness={s.harness} size={14} />
              <span className="truncate text-[12px] text-[var(--t-fg2)]">{s.title}</span>
            </button>
          ))}
        </div>
      </div>
    </>,
    document.body,
  );
}
