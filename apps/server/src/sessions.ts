import { randomUUID } from "node:crypto";
import type { HarnessId, ProtoEvent } from "@truss/proto";
import { store } from "./db.js";
import { composePractices } from "./practices.js";
import { piAdapter } from "./adapters/pi.js";
import { dshAdapter } from "./adapters/dsh.js";
import { claudeAdapter } from "./adapters/claude.js";
import { hermesAdapter } from "./adapters/hermes.js";
import type { AdapterHandle, HarnessAdapter, SessionOpts } from "./adapters/types.js";

const adapters = new Map<HarnessId, HarnessAdapter>([
  [piAdapter.id, piAdapter],
  [dshAdapter.id, dshAdapter],
  [claudeAdapter.id, claudeAdapter],
  [hermesAdapter.id, hermesAdapter],
]);

/** node-agents register remote harnesses (e.g. "pi@rew2") at runtime */
export function registerAdapter(id: HarnessId, a: HarnessAdapter) {
  adapters.set(id, a);
}
export function unregisterAdapter(id: HarnessId) {
  adapters.delete(id);
}

interface LiveSession {
  adapter: HarnessAdapter;
  handle: AdapterHandle;
}

const live = new Map<string, LiveSession>();

/** wire frame: seq is the event-log rowid; clients dedupe replay vs live by it */
export interface EventFrame {
  seq: number;
  ev: ProtoEvent;
}

let broadcastFn: (f: EventFrame) => void = () => {};

export function setBroadcaster(fn: (f: EventFrame) => void) {
  broadcastFn = fn;
}

/** broadcast a non-persisted frame (feed/todo upserts live in their own tables) */
export function broadcastRaw(ev: ProtoEvent) {
  broadcastFn({ seq: 0, ev });
}

/* side-channel subscribers (the feed's auto-posters) — see every event after
   persistence, never block the bus */
type EventListener = (ev: ProtoEvent) => void;
const listeners = new Set<EventListener>();
export function onEvent(fn: EventListener) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Persist + fan out one event. The single sink every adapter event flows through. */
function sink(ev: ProtoEvent) {
  let seq = 0;
  try {
    seq = store.appendEvent(ev);
  } catch (err) {
    console.error("persist failed", err);
  }
  if (ev.type === "session.state") {
    store.setSessionState(ev.sessionId, ev.state);
  }
  broadcastFn({ seq, ev });
  for (const fn of listeners) {
    try {
      fn(ev);
    } catch (err) {
      console.error("event listener failed", err);
    }
  }
}

/**
 * On boot every previously-live session's harness process is gone — includes
 * sessions whose dying adapter flipped them to "error" during the shutdown.
 * Mark them closed; their transcripts stay replayable from the event store.
 */
export function reconcileOnBoot() {
  for (const s of store.listSessions()) {
    if (s.state !== "closed") {
      store.setSessionState(s.id, "closed");
      settleOrphanedPerms(s.id);
    }
  }
}

/** cancel every unanswered permission card — a dead harness can't be answered */
function settleOrphanedPerms(sessionId: string) {
  const frames = store.listEvents(sessionId).map((f) => f.ev);
  for (const ev of frames) {
    if (ev.type === "perm.request") {
      const resolved = frames.some((e) => e.type === "perm.resolve" && e.requestId === ev.requestId);
      if (!resolved) {
        sink({ type: "perm.resolve", sessionId, requestId: ev.requestId, choice: "cancelled" });
      }
    }
  }
}

/** the spawn budget — a wedged harness (issue #12: hermes stalled 10m03s
   attaching MCP) must fail fast and flip the row to error, never an eternal
   "Booting…" spinner */
export const SPAWN_TIMEOUT_MS = 90_000;

/**
 * Bound an adapter.spawn with the spawn budget. Every spawn goes through here
 * — create, resume, and model-switch respawn alike: a wedged harness must fail
 * fast at each of them. A spawn that outlives the budget can still land a live
 * child, so the abandoned handle is disposed when it eventually settles; a
 * spawn left dangling with no owner and no event pump leaks the harness
 * process, one per retry.
 */
async function boundedSpawn(
  adapter: HarnessAdapter,
  opts: SessionOpts,
  budget: number = SPAWN_TIMEOUT_MS,
): Promise<AdapterHandle> {
  let spawnRej: (e: Error) => void = () => {};
  const budgetPromise = new Promise<never>((_, rej) => (spawnRej = rej));
  const budgetTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
    /* plain copy, no em dash: this message is sunk as the session row's error
       detail and shown to the user in the web UI (TRUSS.md) */
    spawnRej(new Error(`${adapter.id} didn't answer spawn within ${Math.round(budget / 1000)}s; the harness may be wedged`));
  }, budget);
  budgetTimer.unref?.();

  let spawning: Promise<AdapterHandle> | undefined;
  try {
    /* inside the try: an adapter that throws synchronously (registerAdapter
       is the seam runtime harnesses plug into) must not escape before the
       finally below disowns the budget timer — an armed timer would reject
       budgetPromise with nobody awaiting it, and Node treats that as a
       crash */
    spawning = adapter.spawn(opts);
    return await Promise.race([spawning, budgetPromise]);
  } catch (err) {
    if (spawning) {
      void spawning.then(
        (h) => {
          try {
            /* mark it first: the adapter's dispose frees the local side but
               must keep its hands off the harness session — on a resume that
               session is the one a concurrent retry is bringing back */
            h.abandoned = true;
            adapter.dispose(h);
          } catch {
            /* already gone */
          }
        },
        () => {
          /* the spawn failed on its own — nothing to clean up */
        },
      );
    }
    throw err;
  } finally {
    clearTimeout(budgetTimer);
  }
}

export async function createSession(
  input: {
    harness: HarnessId;
    cwd: string;
    model?: string;
    provider?: string;
    title?: string;
    project?: string;
  },
  opts: { spawnTimeoutMs?: number } = {},
) {
  const adapter = adapters.get(input.harness);
  if (!adapter) throw new Error(`unknown harness: ${input.harness}`);

  const id = randomUUID().slice(0, 8);
  const title = input.title?.trim() || "new session";
  store.createSession({
    id,
    harness: input.harness,
    title,
    cwd: input.cwd,
    model: input.model,
    provider: input.provider,
    project: input.project,
  });

  sink({
    type: "session.created",
    sessionId: id,
    harness: input.harness,
    title,
    cwd: input.cwd,
    model: input.model,
    project: input.project,
    at: Date.now(),
  });

  let handle: AdapterHandle;
  try {
    handle = await boundedSpawn(
      adapter,
      {
        sessionId: id,
        cwd: input.cwd,
        model: input.model,
        provider: input.provider,
      },
      opts.spawnTimeoutMs ?? SPAWN_TIMEOUT_MS,
    );
  } catch (err) {
    /* timeout OR plain rejection: mark the row error so the UI tells the
       truth instead of spinning "spawning" forever — the event is the write,
       the sink persists session.state rows itself */
    const detail = err instanceof Error ? err.message : String(err);
    sink({ type: "session.state", sessionId: id, state: "error", detail });
    throw err;
  }
  goLive(id, adapter, handle);
  /* harness refs persist lazily from the event pump (goLive) */
  return store.getSession(id)!;
}

/** register + pump a live handle; persist the harness's session ref when it appears */
function goLive(id: string, adapter: HarnessAdapter, handle: AdapterHandle) {
  live.set(id, { adapter, handle });
  void (async () => {
    for await (const ev of adapter.events(handle)) {
      /* harness refs can arrive late (claude: with the first turn; pi: async
         get_state) — persist as soon as they appear or change */
      const ref = handle.harnessRef;
      if (ref && store.getSession(id)?.harness_ref !== ref) {
        store.setHarnessRef(id, ref);
      }
      sink(ev);
    }
  })();
}

/**
 * Resume a previously-closed session whose harness persisted its own session
 * (pi session file / ACP resume / claude --resume). Returns false if the
 * harness can't resume — the caller surfaces the error.
 */
export async function resumeSession(id: string, opts: { spawnTimeoutMs?: number } = {}): Promise<boolean> {
  const row = store.getSession(id);
  if (!row?.harness_ref) return false;
  const adapter = adapters.get(row.harness);
  if (!adapter) return false;
  try {
    const handle = await boundedSpawn(
      adapter,
      {
        sessionId: id,
        cwd: row.cwd,
        model: row.model ?? undefined,
        provider: row.provider ?? undefined,
        resumeRef: row.harness_ref,
      },
      opts.spawnTimeoutMs ?? SPAWN_TIMEOUT_MS,
    );
    goLive(id, adapter, handle);
    if (handle.harnessRef && handle.harnessRef !== row.harness_ref) {
      store.setHarnessRef(id, handle.harnessRef);
    }
    store.setSessionState(id, "idle");
    sink({ type: "session.state", sessionId: id, state: "idle" });
    return true;
  } catch (err) {
    console.error(`resume failed for ${id}:`, err);
    return false;
  }
}

export async function sendPrompt(sessionId: string, text: string) {
  let s = live.get(sessionId);
  if (!s) {
    const row = store.getSession(sessionId);
    if (!row) throw new Error(`no such session: ${sessionId}`);
    /* dead but resumable (closed by restart, or adapter died into error) —
       the harness persisted its own session */
    if ((row.state === "closed" || row.state === "error") && row.harness_ref) {
      const ok = await resumeSession(sessionId);
      if (ok) s = live.get(sessionId);
    }
    if (!s) throw new Error(`session is ${row.state} — harness process not running`);
  }
  // the user bubble is a local echo: instant in UI, persisted like everything else
  const messageId = `u-${Date.now()}`;
  sink({ type: "msg.start", sessionId, messageId, role: "user", at: Date.now() });
  sink({ type: "msg.chunk", sessionId, messageId, text });
  sink({ type: "msg.done", sessionId, messageId });
  // auto-title from the first prompt
  const row = store.getSession(sessionId);
  if (row && row.title === "new session") {
    const title = text.replace(/\s+/g, " ").trim().slice(0, 48);
    if (title) store.setSessionTitle(sessionId, title);
  }
  /* practices for harnesses without MCP (pi): TRUSS.md layers + the posting
     guide ride the first prompt of the session, marked and collapsible */
  let outbound = text;
  if (row && !MCP_ATTACHED.has(baseOf(row.harness)) && !firstPromptDone.has(sessionId)) {
    const { composed } = composePractices(row.cwd, row.project);
    if (composed.trim()) {
      outbound = `[truss practices — follow these; they're the user's house rules]\n${composed}\n\n${POSTING_GUIDE_PI}\n[/truss practices]\n\n${text}`;
    }
    firstPromptDone.add(sessionId);
  }
  s!.adapter.send(s!.handle, outbound);
}

/* harnesses whose adapters attach the per-session truss MCP server (they get
   practices via the server's instructions field instead) */
const MCP_ATTACHED = new Set(["claude-code", "dsh", "hermes"]);
const firstPromptDone = new Set<string>();
const baseOf = (harness: string) => harness.split("@")[0];
const POSTING_GUIDE_PI = `This host has no tool bus, so act on the practices directly and keep the user's task board honest in plain text.`;


export function interrupt(sessionId: string) {
  const s = live.get(sessionId);
  if (!s) throw new Error(`session not live: ${sessionId}`);
  s.adapter.interrupt(s.handle);
}

/**
 * Switch a session's model (and provider — they move as a pair).
 *  - "live":    the adapter switched in place (pi set_model), no restart
 *  - "restart": harness process respawned on its own persisted session —
 *               history intact (claude/dsh/hermes have no live switch)
 *  - "stored":  session isn't live; applies the next time it spawns/resumes
 */
export async function switchModel(
  sessionId: string,
  model: string,
  provider?: string,
  opts: { spawnTimeoutMs?: number } = {},
): Promise<{ mode: "live" | "restart" | "stored" }> {
  const row = store.getSession(sessionId);
  if (!row) throw new Error(`no such session: ${sessionId}`);
  if (!model) throw new Error("model is required");
  const s = live.get(sessionId);

  let mode: "live" | "restart" | "stored" = "stored";
  if (s) {
    if (s.adapter.setModel) {
      await s.adapter.setModel(s.handle, provider, model);
      mode = "live";
    } else {
      if (row.state === "running") {
        throw new Error("session is running — interrupt it, then switch (this harness can't swap models mid-turn)");
      }
      /* respawn on the harness's own session ref; without one the process
         hasn't persisted anything yet, so a fresh spawn loses nothing */
      s.adapter.dispose(s.handle);
      live.delete(sessionId);
      let handle: AdapterHandle;
      try {
        handle = await boundedSpawn(
          s.adapter,
          {
            sessionId,
            cwd: row.cwd,
            model,
            provider,
            resumeRef: row.harness_ref ?? undefined,
          },
          opts.spawnTimeoutMs ?? SPAWN_TIMEOUT_MS,
        );
      } catch (err) {
        /* the live handle is already gone — without this flip the row keeps
           its pre-switch state ("idle" for any live session) while nothing
           serves it, and sendPrompt's closed/error gate then refuses the
           session on every later try. Mirrors createSession. */
        const detail = err instanceof Error ? err.message : String(err);
        sink({ type: "session.state", sessionId, state: "error", detail });
        throw err;
      }
      goLive(sessionId, s.adapter, handle);
      if (handle.harnessRef && handle.harnessRef !== row.harness_ref) {
        store.setHarnessRef(sessionId, handle.harnessRef);
      }
      mode = "restart";
    }
  }

  store.setSessionModel(sessionId, model, provider ?? null);
  sink({ type: "session.updated", sessionId, model, provider: provider ?? null });

  const label = provider ? `${provider}/${model}` : model;
  const note =
    mode === "live"
      ? `model switched to ${label}`
      : mode === "restart"
        ? `model switched to ${label} — harness restarted, history kept`
        : `model set to ${label} — applies when the session resumes`;
  const noteId = `m-sys-${Date.now()}`;
  sink({ type: "msg.start", sessionId, messageId: noteId, role: "system", at: Date.now() });
  sink({ type: "msg.chunk", sessionId, messageId: noteId, text: note });
  sink({ type: "msg.done", sessionId, messageId: noteId });
  return { mode };
}

export function resolvePermission(sessionId: string, requestId: string, choice: string) {
  const s = live.get(sessionId);
  if (!s?.adapter.resolve) throw new Error(`session ${sessionId} has no permission host`);
  s.adapter.resolve(s.handle, requestId, choice);
  sink({ type: "perm.resolve", sessionId, requestId, choice });
}

export function closeSession(sessionId: string) {
  const s = live.get(sessionId);
  if (s) {
    s.adapter.dispose(s.handle);
    live.delete(sessionId);
  }
  store.setSessionState(sessionId, "closed");
  settleOrphanedPerms(sessionId);
}

/** archive/unarchive — hidden from the sidebar, history kept, still resumable */
export function setSessionArchived(sessionId: string, archived: boolean) {
  const row = store.getSession(sessionId);
  if (!row) throw new Error(`no such session: ${sessionId}`);
  store.setArchived(sessionId, archived);
  sink({ type: "session.updated", sessionId, archived });
}

/** every session under a project tag */
export function setProjectArchived(project: string, archived: boolean): number {
  const rows = store.sessionsInProject(project);
  for (const r of rows) {
    store.setArchived(r.id, archived);
    sink({ type: "session.updated", sessionId: r.id, archived });
  }
  return rows.length;
}

/** close (if live) + delete the row and its entire event log */
export function deleteSession(sessionId: string) {
  closeSession(sessionId);
  store.deleteSession(sessionId);
  /* every connected client drops it from the sidebar immediately. The event
     can't be persisted (the FK cascade removes the log with the row), so
     offline clients catch up via the reconnect resync's session refetch. */
  broadcastFn({
    seq: 0,
    ev: { type: "session.deleted", sessionId },
  });
}

export function listHarnesses() {
  return [...adapters.values()].map((a) => ({
    id: a.id,
    capabilities: a.capabilities,
  }));
}

export async function listModels() {
  const out: { harness: string; provider: string; model: string; label: string }[] = [];
  for (const a of adapters.values()) {
    for (const m of await a.listModels()) out.push({ harness: a.id, ...m });
  }
  return out;
}

export function isLive(sessionId: string) {
  return live.has(sessionId);
}
