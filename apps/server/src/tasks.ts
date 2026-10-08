import { randomUUID } from "node:crypto";
import { store } from "./db.js";
import { createSession, sendPrompt } from "./sessions.js";
import { cronSyntaxError, nextCronRun } from "./cron.js";
import type { HarnessId } from "@truss/proto";

/**
 * Task board (a lean clone of the dsh-lab task-board plugin): a persistent
 * kanban of agent tasks. "Run" spawns a real session with the task's pinned
 * harness + cwd and sends the task prompt; the card links to that session.
 * Cards may carry a 5-field cron schedule (issue #16): the scheduler tick in
 * scheduler.ts fires due cards through this same runTask path. Agents get
 * mcp__truss__ task tools (including schedule_task), so a running agent can
 * file cards and recurring work itself.
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
  schedule: string | null;
  next_run_at: number | null;
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
  /* migrations (issue #16): the cron schedule + its computed next slot */
  const cols = store.all<{ name: string }>(`PRAGMA table_info(tasks)`);
  if (!cols.some((c) => c.name === "schedule")) {
    store.exec(`ALTER TABLE tasks ADD COLUMN schedule TEXT`);
  }
  if (!cols.some((c) => c.name === "next_run_at")) {
    store.exec(`ALTER TABLE tasks ADD COLUMN next_run_at INTEGER`);
  }
}

let ready = false;
function table() {
  if (!ready) {
    ensureTable();
    ready = true;
  }
}

/** cross-module readers (feed autoposter, scheduler) must guarantee the table exists */
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
    schedule: t.schedule ?? undefined,
    nextRunAt: t.next_run_at ?? undefined,
  };
}

/** Validate a cron expression for storage; throws with the parse reason. */
function assertValidSchedule(schedule: string): string {
  const expr = schedule.trim();
  const err = cronSyntaxError(expr);
  if (err) throw new Error(`bad schedule: ${err}`);
  if (nextCronRun(expr, Date.now()) === null) {
    throw new Error(`bad schedule: ${JSON.stringify(expr)} parses but never fires (e.g. February 31)`);
  }
  return expr;
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

/** Cards the scheduler tick owes a look: scheduled, in an active column, due. */
export function dueScheduledTasks(nowMs: number): TaskRow[] {
  table();
  return store.all<TaskRow>(
    `SELECT * FROM tasks WHERE schedule IS NOT NULL AND next_run_at IS NOT NULL AND next_run_at <= ? AND status IN ('todo', 'doing')`,
    nowMs,
  );
}

/** Consume a firing: advance the card's waterline past `fromMs`. */
export function advanceTaskSchedule(id: string, fromMs: number) {
  table();
  const t = getTask(id);
  if (!t?.schedule) return;
  store.run(`UPDATE tasks SET next_run_at = ? WHERE id = ?`, nextCronRun(t.schedule, fromMs), id);
}

/** Planning refinement (issue #16): even a failed run stamps the card, so a
    broken schedule reports instead of silently skipping forever. */
export function stampTaskRun(id: string, atMs: number) {
  table();
  store.run(`UPDATE tasks SET last_run_at = ?, updated_at = ? WHERE id = ?`, atMs, atMs, id);
}

export function createTask(input: { title: string; prompt: string; cwd: string; harness: string; schedule?: string | null }) {
  table();
  if (!input.title.trim()) throw new Error("title required");
  const schedule = input.schedule?.trim() ? assertValidSchedule(input.schedule) : null;
  const now = Date.now();
  const id = randomUUID().slice(0, 8);
  store.run(
    `INSERT INTO tasks (id, title, prompt, cwd, harness, status, created_at, updated_at, schedule, next_run_at) VALUES (?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?)`,
    id, input.title.trim(), input.prompt, input.cwd, input.harness, now, now, schedule,
    schedule ? nextCronRun(schedule, now) : null,
  );
  return getTaskApi(id)!;
}

export function updateTask(id: string, patch: { title?: string; prompt?: string; status?: TaskStatus; schedule?: string | null }) {
  table();
  const t = getTask(id);
  if (!t) throw new Error(`no such task: ${id}`);
  if (patch.status && !["todo", "doing", "done", "archived"].includes(patch.status)) throw new Error("bad status");
  /* schedule: undefined leaves it; null/"" clears; anything else validates */
  let schedule = t.schedule;
  if (patch.schedule !== undefined) {
    schedule = patch.schedule?.trim() ? assertValidSchedule(patch.schedule) : null;
  }
  /* recompute the waterline whenever the schedule or the column changes —
     a card parked in done for a month must not fire a month of catch-ups on
     restore; its next run is the next FUTURE slot */
  const nextRunAt = !schedule
    ? null
    : patch.schedule !== undefined || patch.status !== undefined || t.next_run_at == null
      ? nextCronRun(schedule, Date.now())
      : t.next_run_at;
  store.run(
    `UPDATE tasks SET title = ?, prompt = ?, status = ?, updated_at = ?, schedule = ?, next_run_at = ? WHERE id = ?`,
    patch.title ?? t.title, patch.prompt ?? t.prompt, patch.status ?? t.status, Date.now(), schedule, nextRunAt, id,
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
