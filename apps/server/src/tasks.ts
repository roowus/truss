import { randomUUID } from "node:crypto";
import { store } from "./db.js";
import { createSession, sendPrompt } from "./sessions.js";
import type { HarnessId } from "@truss/proto";

/**
 * Task board (a lean clone of the dsh-lab task-board plugin): a persistent
 * kanban of agent tasks. "Run" spawns a real session with the task's pinned
 * harness + cwd and sends the task prompt; the card links to that session.
 * No cron/scheduling in v1 — the board is user- and agent-driven (agents get
 * mcp__truss__ task tools, so a running agent can file cards itself).
 */

export type TaskStatus = "todo" | "doing" | "done" | "archived";

export interface TaskRow {
  id: string;
  title: string;
  prompt: string;
  cwd: string;
  harness: string;
  status: TaskStatus;
  session_id: string | null;
  created_at: number;
  updated_at: number;
  last_run_at: number | null;
}

function ensureTable() {
  store.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      prompt      TEXT NOT NULL DEFAULT '',
      cwd         TEXT NOT NULL,
      harness     TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'todo',
      session_id  TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      last_run_at INTEGER
    );
  `);
}

let ready = false;
function table() {
  if (!ready) {
    ensureTable();
    ready = true;
  }
}

/** cross-module readers (feed autoposter) must guarantee the table exists */
export function ensureTasksTable() {
  table();
}

/** API shape: camelCase (web TaskInfo) */
function camel(t: TaskRow) {
  return {
    id: t.id,
    title: t.title,
    prompt: t.prompt,
    cwd: t.cwd,
    harness: t.harness,
    status: t.status,
    sessionId: t.session_id ?? undefined,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    lastRunAt: t.last_run_at ?? undefined,
  };
}

export function listTasks() {
  table();
  return store.all<TaskRow>(`SELECT * FROM tasks ORDER BY CASE status WHEN 'doing' THEN 0 WHEN 'todo' THEN 1 WHEN 'done' THEN 2 ELSE 3 END, updated_at DESC`).map(camel);
}

export function getTask(id: string): TaskRow | undefined {
  table();
  return store.get<TaskRow>(`SELECT * FROM tasks WHERE id = ?`, id);
}

export function getTaskApi(id: string) {
  const t = getTask(id);
  return t ? camel(t) : undefined;
}

export function createTask(input: { title: string; prompt: string; cwd: string; harness: string }) {
  table();
  if (!input.title.trim()) throw new Error("title required");
  const now = Date.now();
  const id = randomUUID().slice(0, 8);
  store.run(
    `INSERT INTO tasks (id, title, prompt, cwd, harness, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'todo', ?, ?)`,
    id, input.title.trim(), input.prompt, input.cwd, input.harness, now, now,
  );
  return getTaskApi(id)!;
}

export function updateTask(id: string, patch: { title?: string; prompt?: string; status?: TaskStatus }) {
  table();
  const t = getTask(id);
  if (!t) throw new Error(`no such task: ${id}`);
  if (patch.status && !["todo", "doing", "done", "archived"].includes(patch.status)) throw new Error("bad status");
  store.run(
    `UPDATE tasks SET title = ?, prompt = ?, status = ?, updated_at = ? WHERE id = ?`,
    patch.title ?? t.title, patch.prompt ?? t.prompt, patch.status ?? t.status, Date.now(), id,
  );
  return getTaskApi(id)!;
}

export function deleteTask(id: string) {
  table();
  store.run(`DELETE FROM tasks WHERE id = ?`, id);
}

/** Run a task: spin up its session (pinned harness + cwd) and send the prompt. */
export async function runTask(id: string) {
  const t = getTask(id);
  if (!t) throw new Error(`no such task: ${id}`);
  if (!t.prompt.trim()) throw new Error("task has no prompt to run");
  const session = await createSession({
    harness: t.harness as HarnessId,
    cwd: t.cwd,
    title: t.title.slice(0, 60),
    project: "taskboard",
  });
  const sid = session.id;
  store.run(`UPDATE tasks SET status = 'doing', session_id = ?, last_run_at = ?, updated_at = ? WHERE id = ?`, sid, Date.now(), Date.now(), id);
  /* send after the adapter is live — createSession resolves once spawning is
     underway; a short defer lets the harness bind before the prompt lands */
  void sendPrompt(sid, t.prompt).catch(() => {
    store.run(`UPDATE tasks SET status = 'todo', updated_at = ? WHERE id = ?`, Date.now(), id);
  });
  return { session };
}
