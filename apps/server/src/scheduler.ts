import { store } from "./db.js";
import { nextCronRun } from "./cron.js";
import { advanceTaskSchedule, dueScheduledTasks, getTask, runTask, stampTaskRun } from "./tasks.js";
import { isLive } from "./sessions.js";
import { postFeed } from "./feed.js";

/**
 * The cron scheduler (issue #16): a minute-granularity tick that fires due
 * task cards through the existing runTask path (spawn → prompt → link).
 *
 * Policies (decided in the issue's planning pass, documented in the PR):
 * - CATCH-UP: per card, downtime coalesces to ONE run. The card's
 *   next_run_at is the waterline — every slot it points past is "missed".
 *   The first tick after a gap fires the card once and posts "missed N runs
 *   while down". (The planning pass sketched a kv last_tick_at instead; the
 *   per-card waterline subsumes it — a card written just before a shutdown
 *   has its own correct waterline, which a global tick stamp cannot have.)
 * - OVERLAP: a card whose previous run is still live (spawning/running) is
 *   SKIPPED for that slot, with a feed note. Runs of one card never pile up.
 * - FAILURE: a failed spawn still stamps last_run_at and advances the
 *   waterline (planning refinement) — a broken card reports once an hour
 *   instead of silently retrying every minute or vanishing.
 * - CLOCK: schedules are SERVER-local wall-clock ("0 9 * * 1-5" means 9am on
 *   the host this server runs on — which for a remote node-agent rig is the
 *   server's clock, not the agent's).
 * - Columns gate firing: only todo/doing cards fire. Moving a card to done
 *   or archived pauses its schedule; moving it back re-arms at the next
 *   FUTURE slot (no backlog replay — see updateTask).
 */

export interface TickResult {
  ran: string[];
  skipped: string[];
  failed: string[];
}

/** Fire times of `schedule` in [firstMiss, nowMs], capped at 501 — the cap
    keeps a months-down every-minute card from iterating half a million slots
    just to write a feed note. 501 means "500 or more missed". */
function countSlots(schedule: string, firstMiss: number, nowMs: number): number {
  let count = 0;
  let t = firstMiss;
  while (t <= nowMs && count <= 500) {
    count++;
    const next = nextCronRun(schedule, t);
    if (next == null || next <= t) break; // unreachable for validated schedules
    t = next;
  }
  return count;
}

/* Ticks are serialized (audit B1): a slow spawn must not let the next
   minute's tick re-fire cards from a stale due-snapshot. A collided tick
   simply skips — the waterlines make the following minute catch anything
   still due, so skipping costs at most a minute of latency. */
let tickInFlight = false;

export async function runSchedulerTick(nowMs = Date.now()): Promise<TickResult> {
  const result: TickResult = { ran: [], skipped: [], failed: [] };
  if (tickInFlight) return result;
  tickInFlight = true;
  try {
    for (const due of dueScheduledTasks(nowMs)) {
      /* re-read the row fresh: the snapshot goes stale the moment an await
         (or the user) intervenes — a card deleted, cleared, or fired since
         the snapshot must not run */
      const task = getTask(due.id);
      if (!task?.schedule || task.next_run_at == null || task.next_run_at > nowMs) continue;
      if (task.status !== "todo" && task.status !== "doing") continue;
      const schedule = task.schedule;
      const missed = countSlots(schedule, task.next_run_at, nowMs) - 1; // minus the slot we fire now
      /* consume the slot(s) first: whatever happens below, this firing is over */
      advanceTaskSchedule(task.id, nowMs);

      const linked = task.session_id ? store.getSession(task.session_id) : undefined;
      if (linked && isLive(linked.id) && (linked.state === "running" || linked.state === "spawning")) {
        result.skipped.push(task.id);
        postFeed({
          type: "note",
          title: `Skipped scheduled run: ${task.title}`,
          body: "The card's previous run is still going, so this slot was skipped. The next slot stays on schedule.",
          importance: "low",
          data: { taskId: task.id },
          dedupeKey: `cron-skip:${task.id}:${Math.floor(nowMs / 3_600_000)}`,
        });
        continue;
      }

      try {
        await runTask(task.id);
        result.ran.push(task.id);
        if (missed > 0) {
          postFeed({
            type: "task_run",
            title: `Caught up scheduled task: ${task.title}`,
            body: `Ran once now; skipped ${missed >= 500 ? "500+" : missed} missed run${missed === 1 ? "" : "s"} while down. Coalesce policy: downtime collapses to a single run.`,
            importance: "normal",
            data: { taskId: task.id },
            dedupeKey: `cron-catchup:${task.id}:${Math.floor(nowMs / 86_400_000)}`,
          });
        }
      } catch (err) {
        result.failed.push(task.id);
        stampTaskRun(task.id, nowMs);
        postFeed({
          type: "error",
          title: `Scheduled run failed: ${task.title}`,
          body: String(err instanceof Error ? err.message : err),
          importance: "high",
          data: { taskId: task.id },
          dedupeKey: `cron-fail:${task.id}:${Math.floor(nowMs / 3_600_000)}`,
        });
      }
    }
    return result;
  } finally {
    tickInFlight = false;
  }
}

/** Boot: catch up once from the waterlines, then tick just past each minute
    boundary. Self-rearming timeout (no interval drift); unref'd like the WS
    heartbeat so it never holds a test/dev process open. */
export function startScheduler() {
  void runSchedulerTick().catch(() => undefined);
  const arm = () => {
    const now = Date.now();
    const nextBoundary = Math.floor(now / 60_000) * 60_000 + 60_000 + 250;
    const timer = setTimeout(() => {
      void runSchedulerTick().catch(() => undefined);
      arm();
    }, nextBoundary - now);
    timer.unref();
  };
  arm();
}
