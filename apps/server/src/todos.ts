import { randomUUID } from "node:crypto";
import { store } from "./db.js";
import { postFeed, settleFeedWhere } from "./feed.js";
import type { TodoItem, TodoPriority, TodoStatus, TodoSubtask } from "@truss/proto";

/**
 * Todos — user-facing tasks filed by agents ("verify the page I built",
 * "renew the cert before Friday") with priorities, deadlines, labels,
 * subtasks, estimates and free-form agent-chosen fields (meta). Ownership is
 * enforced at the tool layer: a session may only edit its own todos unless
 * the user approves a per-task access card in the feed.
 */

interface TodoRow {
  id: string;
  session_id: string | null;
  title: string;
  notes: string;
  priority: string;
  deadline: number | null;
  estimate: string | null;
  labels: string;
  subtasks: string;
  meta: string;
  status: string;
  done_at: number | null;
  created_by: string;
  shared_editors: string;
  denied_editors: string;
  created_at: number;
  updated_at: number;
}

let ready = false;
function table() {
  if (ready) return;
  store.exec(`
    CREATE TABLE IF NOT EXISTS todos (
      id             TEXT PRIMARY KEY,
      session_id     TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      title          TEXT NOT NULL,
      notes          TEXT NOT NULL DEFAULT '',
      priority       TEXT NOT NULL DEFAULT 'normal',
      deadline       INTEGER,
      estimate       TEXT,
      labels         TEXT NOT NULL DEFAULT '[]',
      subtasks       TEXT NOT NULL DEFAULT '[]',
      meta           TEXT NOT NULL DEFAULT '{}',
      status         TEXT NOT NULL DEFAULT 'open',
      done_at        INTEGER,
      created_by     TEXT NOT NULL DEFAULT 'user',
      shared_editors TEXT NOT NULL DEFAULT '[]',
      denied_editors TEXT NOT NULL DEFAULT '[]',
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status, updated_at DESC);
  `);
  ready = true;
}

function camel(r: TodoRow): TodoItem {
  return {
    id: r.id,
    sessionId: r.session_id ?? undefined,
    title: r.title,
    notes: r.notes,
    priority: r.priority as TodoPriority,
    deadline: r.deadline ?? undefined,
    estimate: r.estimate ?? undefined,
    labels: JSON.parse(r.labels || "[]"),
    subtasks: JSON.parse(r.subtasks || "[]"),
    meta: JSON.parse(r.meta || "{}"),
    status: r.status as TodoStatus,
    doneAt: r.done_at ?? undefined,
    createdBy: r.created_by as "user" | "agent",
    sharedEditors: JSON.parse(r.shared_editors || "[]"),
    deniedEditors: JSON.parse(r.denied_editors || "[]"),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

let broadcast: (todo: TodoItem) => void = () => {};
export function setTodoBroadcaster(fn: (todo: TodoItem) => void) {
  broadcast = fn;
}

export function listTodos(): TodoItem[] {
  table();
  return store.all<TodoRow>(`SELECT * FROM todos ORDER BY updated_at DESC LIMIT 2000`).map(camel);
}

export function getTodo(id: string): TodoItem | undefined {
  table();
  const r = store.get<TodoRow>(`SELECT * FROM todos WHERE id = ?`, id);
  return r ? camel(r) : undefined;
}

export interface TodoPatch {
  title?: string;
  notes?: string;
  priority?: TodoPriority;
  deadline?: number | null;
  estimate?: string | null;
  labels?: string[];
  subtasks?: TodoSubtask[];
  meta?: Record<string, unknown>;
  status?: TodoStatus;
}

function applyPatch(id: string, p: TodoPatch): TodoItem {
  const t = getTodo(id);
  if (!t) throw new Error(`no such todo: ${id}`);
  if (p.priority && !["low", "normal", "high", "urgent"].includes(p.priority)) throw new Error("bad priority");
  if (p.status && !["open", "done", "dropped"].includes(p.status)) throw new Error("bad status");
  const statusChanged = p.status && p.status !== t.status;
  const doneAt = p.status === "done" ? Date.now() : p.status === "open" ? null : t.doneAt ?? null;
  store.run(
    `UPDATE todos SET title=?, notes=?, priority=?, deadline=?, estimate=?, labels=?, subtasks=?, meta=?, status=?, done_at=?, updated_at=? WHERE id=?`,
    p.title ?? t.title,
    p.notes ?? t.notes,
    p.priority ?? t.priority,
    p.deadline === undefined ? t.deadline ?? null : p.deadline,
    p.estimate === undefined ? t.estimate ?? null : p.estimate,
    JSON.stringify(p.labels ?? t.labels),
    JSON.stringify(p.subtasks ?? t.subtasks),
    JSON.stringify(p.meta ?? t.meta),
    p.status ?? t.status,
    doneAt,
    Date.now(),
    id,
  );
  const next = getTodo(id)!;
  broadcast(next);
  /* a todo that leaves the open state settles its feed card too */
  if (statusChanged && (p.status === "done" || p.status === "dropped")) settleTodoCard(next, p.status);
  return next;
}

function settleTodoCard(t: TodoItem, _status: TodoStatus) {
  /* the todo's auto-posted card is dedupe-keyed todo:<id>; going through
     feed.ts (not a direct query) also guarantees the feed table exists —
     a postToFeed:false todo settled before ANY card ever posted used to die
     with "no such table: feed_items" */
  settleFeedWhere(`todo:${t.id}`, "done");
}

export function createTodo(input: {
  title: string;
  notes?: string;
  priority?: TodoPriority;
  deadline?: number | null;
  estimate?: string | null;
  labels?: string[];
  subtasks?: TodoSubtask[];
  meta?: Record<string, unknown>;
  sessionId?: string;
  createdBy: "user" | "agent";
  postToFeed?: boolean;
}): TodoItem {
  table();
  if (!input.title.trim()) throw new Error("title required");
  const now = Date.now();
  const id = randomUUID().slice(0, 8);
  store.run(
    `INSERT INTO todos (id, session_id, title, notes, priority, deadline, estimate, labels, subtasks, meta, status, created_by, shared_editors, denied_editors, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, '[]', '[]', ?, ?)`,
    id, input.sessionId ?? null, input.title.trim(), input.notes ?? "",
    input.priority ?? "normal", input.deadline ?? null, input.estimate ?? null,
    JSON.stringify(input.labels ?? []), JSON.stringify(input.subtasks ?? []),
    JSON.stringify(input.meta ?? {}), input.createdBy, now, now,
  );
  const todo = getTodo(id)!;
  broadcast(todo);
  if (input.postToFeed !== false) {
    postFeed({
      type: "todo",
      sessionId: input.sessionId,
      title: todo.title,
      body: todo.notes,
      importance: todo.priority === "normal" ? "normal" : todo.priority,
      data: { todoId: todo.id },
      dedupeKey: `todo:${todo.id}`,
    });
  }
  return todo;
}

/* ── agent-facing edits with ownership enforcement ── */

export type AgentEditResult =
  | { ok: true; todo: TodoItem }
  | { ok: false; reason: "denied" | "approval_requested" | "not_found" };

export function agentUpdateTodo(callerSession: string, id: string, p: TodoPatch): AgentEditResult {
  const t = getTodo(id);
  if (!t) return { ok: false, reason: "not_found" };
  if (t.sessionId && t.sessionId !== callerSession) {
    if (t.deniedEditors.includes(callerSession)) return { ok: false, reason: "denied" };
    if (!t.sharedEditors.includes(callerSession)) {
      /* file the approval card once per (todo, requester) */
      const requester = store.getSession(callerSession);
      postFeed({
        type: "todo",
        sessionId: t.sessionId,
        title: `Edit request: ${t.title}`,
        body: `**${requester?.title ?? callerSession}** wants to ${p.status ? `mark it **${p.status}**` : "edit it"}${p.title ? ` — new title: “${p.title}”` : ""}.\n\nApprove to let that session update this task.`,
        importance: "high",
        data: { todoId: t.id, requesterId: callerSession, accessRequest: true },
        dedupeKey: `todo-access:${t.id}:${callerSession}`,
      });
      return { ok: false, reason: "approval_requested" };
    }
  }
  return { ok: true, todo: applyPatch(id, p) };
}

/** user decision on an access card */
export function resolveTodoAccess(todoId: string, requesterId: string, approve: boolean): TodoItem {
  const t = getTodo(todoId);
  if (!t) throw new Error(`no such todo: ${todoId}`);
  /* approve lifts any earlier denial too — otherwise a denied session could
     never be let in later (the guard checks denied first, deny was sticky) */
  const shared = approve ? [...new Set([...t.sharedEditors, requesterId])] : t.sharedEditors;
  const denied = approve
    ? t.deniedEditors.filter((d) => d !== requesterId)
    : [...new Set([...t.deniedEditors, requesterId])];
  store.run(`UPDATE todos SET shared_editors = ?, denied_editors = ?, updated_at = ? WHERE id = ?`,
    JSON.stringify(shared), JSON.stringify(denied), Date.now(), todoId);
  const next = getTodo(todoId)!;
  broadcast(next);
  return next;
}

/** user edits bypass ownership (the user is sovereign) */
export function userUpdateTodo(id: string, p: TodoPatch): TodoItem {
  return applyPatch(id, p);
}
