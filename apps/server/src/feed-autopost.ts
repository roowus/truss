import { store } from "./db.js";
import { onEvent } from "./sessions.js";
import { feedSources, postFeed, settleFeedWhere } from "./feed.js";
import type { ProtoEvent } from "@truss/proto";

/**
 * Feed auto-posters — the system cards. Each source is toggleable in
 * Settings (feedSources). Dedupe keys keep repeats from flooding the inbox:
 * permissions settle when resolved anywhere (chat or feed), context nags
 * once per session per day, errors once per session per hour.
 */
export function startFeedAutopost() {
  const lastState = new Map<string, string>();
  const runningSince = new Map<string, number>();

  onEvent((ev: ProtoEvent) => {
    const src = feedSources();
    const sid = ev.sessionId;

    if (ev.type === "perm.request") {
      if (!src.permissions) return;
      const s = store.getSession(sid);
      postFeed({
        type: "permission",
        sessionId: sid,
        title: `${s?.title ?? sid}: ${ev.tool} needs a decision`,
        body: ev.reason,
        importance: "high",
        data: { requestId: ev.requestId, tool: ev.tool, options: ev.options },
        dedupeKey: `perm:${ev.requestId}`,
      });
      return;
    }
    if (ev.type === "perm.resolve") {
      /* answered anywhere (chat card or feed card) — settle the feed twin */
      settleFeedWhere(`perm:${ev.requestId}`, "done");
      return;
    }

    if (ev.type === "session.state") {
      const prev = lastState.get(sid);
      lastState.set(sid, ev.state);
      if (ev.state === "running") {
        runningSince.set(sid, Date.now());
        return;
      }
      if (ev.state === "error" && src.errors) {
        const s = store.getSession(sid);
        postFeed({
          type: "error",
          sessionId: sid,
          title: `${s?.title ?? sid} crashed`,
          body: ev.detail ?? "The harness process died into error state.",
          importance: "high",
          dedupeKey: `err:${sid}:${Math.floor(Date.now() / 3600_000)}`,
        });
        return;
      }
      if (ev.state === "idle" && prev === "running") {
        const s = store.getSession(sid);
        const ms = Date.now() - (runningSince.get(sid) ?? Date.now());
        runningSince.delete(sid);
        if (src.workDone) {
          postFeed({
            type: "work_done",
            sessionId: sid,
            title: `${s?.title ?? sid} finished`,
            body: `Turn settled after ${Math.round(ms / 1000)}s.`,
            importance: "low",
          });
        }
        if (src.taskRuns) {
          /* task-board runs that just settled */
          const tasks = store.all<{ id: string; title: string }>(
            `SELECT id, title FROM tasks WHERE session_id = ? AND status = 'doing'`,
            sid,
          );
          for (const t of tasks) {
            postFeed({
              type: "task_run",
              sessionId: sid,
              title: `Task run finished: ${t.title}`,
              body: "Review the run, then move the card.",
              importance: "normal",
              data: { taskId: t.id },
              dedupeKey: `taskrun:${t.id}:${sid}:${Math.floor(Date.now() / 60_000)}`,
            });
          }
        }
      }
      return;
    }

    if (ev.type === "ctx.usage" && src.context) {
      const pct = ev.used / Math.max(1, ev.total);
      if (pct >= 0.85) {
        const s = store.getSession(sid);
        const day = new Date().toISOString().slice(0, 10);
        postFeed({
          type: "context",
          sessionId: sid,
          title: `${s?.title ?? sid} is ${Math.round(pct * 100)}% through its context window`,
          body: "Consider starting a fresh session and linking back.",
          importance: "normal",
          dedupeKey: `ctx:${sid}:${day}`,
        });
      }
      return;
    }
  });
}
