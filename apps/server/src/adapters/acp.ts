import { spawn, type ChildProcess } from "node:child_process";
import type { ProtoEvent } from "@truss/proto";
import type { AdapterHandle } from "./types.js";

/**
 * Shared ACP (Agent Client Protocol) stdio client + session event mapping.
 * Used by every ACP-speaking harness adapter (dsh, hermes, …).
 *
 * Wire: JSON-RPC 2.0, NDJSON over stdio, LF-framed (U+2028/U+2029 are valid
 * inside JSON strings — never split on them).
 *
 * One server process multiplexes many sessions (`session/new` per session);
 * notifications are routed to session handlers by params.sessionId.
 */

/** per-request budget for ACP calls (initialize, session/new, …) — generous
   for cold python/model boots, never ten minutes (issue #12) */
export const ACP_DEFAULT_TIMEOUT_MS = 60_000;

/* ── ACP wire shapes (only what Truss consumes) ── */

export interface AcpUpdate {
  sessionUpdate: string;
  content?: { type: string; text?: string };
  title?: string;
  toolCallId?: string;
  status?: string;
  kind?: string;
  rawOutput?: unknown;
  used?: number;
  size?: number;
}

export interface AcpPermissionParams {
  sessionId?: string;
  toolCall?: { title?: string; kind?: string };
  options?: { optionId: string; name: string }[];
}

export interface AcpLaunchSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

interface Frame {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string };
}

type SessionHandler = (frame: Frame) => void;

export class AcpClient {
  private proc: ChildProcess | null = null;
  private buf = "";
  private idc = 0;
  private pending = new Map<string, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  private sessionHandlers = new Map<string, SessionHandler>();
  /* registrations refused because a handler already held the key. The refused
     spawn is the retry that is going live right now; the handler holding the
     key is the abandoned spawn whose dispose is about to free it. Recording
     the claimant lets offSession hand the key straight to it instead of
     leaving it empty (issue #12). A list, not a slot: two refused
     registrations on one key are possible (a retry landing while an
     abandoned spawn still holds the key, then another), and a slot would
     leave the first claimant live with no handler and no claim — deaf to
     every frame for that session. */
  private sessionClaims = new Map<string, SessionHandler[]>();
  private ready: Promise<void> | null = null;
  private exitListenersAttached = false;
  /* one per live session the adapters register — when the shared process
     dies, every session it served gets a terminal error event and a closed
     queue, so the event pump ends and the session leaves `live`. Without
     this a process death strands every session: pumps hang, live entries
     persist, and prompts address harness ids the replacement process never
     heard of (the ghost-prompt black hole, issue #97). */
  private processExitListeners = new Set<(err: Error) => void>();

  constructor(
    private launch: AcpLaunchSpec,
    private opts: { requestTimeoutMs?: number } = {},
  ) {}

  async ensure(): Promise<void> {
    if (this.ready) return this.ready;
    const ready = (async () => {
      const proc = spawn(this.launch.command, this.launch.args, {
        stdio: ["pipe", "pipe", "inherit"], // stderr is diagnostics, never protocol
        env: { ...process.env, ...this.launch.env },
        cwd: this.launch.cwd,
      });
      this.proc = proc;
      /* a fresh wire. The buffer survives the previous child otherwise: a
         boot that was killed mid-frame leaves its newline-less tail here, and
         the retry's first line would parse as that tail plus the new child's
         own answer — dropped as unparseable, taking the retry's initialize
         with it. Only one boot runs at a time (this.ready gates re-entry), so
         nothing a live child still owes us can be here. */
      this.buf = "";

      proc.stdout!.setEncoding("utf8");
      proc.stdout!.on("data", (chunk: string) => {
        this.buf += chunk;
        let nl: number;
        while ((nl = this.buf.indexOf("\n")) !== -1) {
          let line = this.buf.slice(0, nl);
          this.buf = this.buf.slice(nl + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (!line.trim()) continue;
          let rec: Frame;
          try {
            rec = JSON.parse(line);
          } catch {
            continue;
          }
          this.dispatch(rec);
        }
      });

      proc.on("exit", () => {
        /* only the CURRENT process may flush client state — after a failed
           boot the half-started child is killed and its exit can land after a
           retry has already spawned a healthy replacement; flushing for the
           dead one would reject the retry's initialize and get that new child
           killed in turn */
        this.flushFor(proc, new Error("acp server exited"));
      });

      /* Node emits 'error' on the ChildProcess when the binary cannot be
         spawned at all: a wrong TRUSS_HERMES_BIN, or dsh missing from PATH.
         An EventEmitter 'error' with no listener throws, and that throw is
         the truss server's uncaughtException — the whole server dies instead
         of landing the error row the failed spawn was about to produce, and
         ensure()'s retry contract turns into a crash loop. A spawn that never
         started has no exit event, so this handler is what flushes the boot's
         pending initialize. pi.ts and claude.ts attach one on their own
         children; the shared client is the seam every ACP harness goes
         through. */
      proc.on("error", (err) => {
        this.flushFor(proc, err);
      });

      /* a write can outrun the child's death: the boot-failure kill and the
         spawn-phase recycle both leave this.proc set for a beat after the
         reader is gone, and call()/respond() write without a guard. EPIPE on
         a stream with no 'error' listener is the same unhandled throw as a
         missing binary. The failed write is a request whose answer never
         comes, so its own budget already rejects it — this listener only has
         to keep the server up. */
      proc.stdin?.on("error", () => {});

      /* never orphan the multiplexed server when the truss server goes down */
      const shutdown = () => {
        try {
          proc.stdin?.end();
        } catch {
          proc.kill("SIGTERM");
        }
      };
      if (!this.exitListenersAttached) {
        this.exitListenersAttached = true;
        process.once("SIGTERM", shutdown);
        process.once("SIGINT", shutdown);
        process.once("exit", shutdown);
      }

      try {
        const init = (await this.call("initialize", {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        })) as { protocolVersion?: number };
        if (!init.protocolVersion) throw new Error("acp initialize failed");
      } catch (e) {
        /* a failed boot must not orphan the half-started child — a dead
           harness that consumed initialize and wedged would otherwise leak
           a process per ensure() attempt (issue #12's silent multiplier) */
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        throw e;
      }
    })();
    this.ready = ready;
    ready.catch(() => {
      /* only clear if nobody replaced us meanwhile (a dispose + fresh
         ensure() must not be unwound by the old boot's late rejection) */
      if (this.ready === ready) this.ready = null;
    });
    return ready;
  }

  /** Flush everything this child still owed and forget it. Runs for both the
     exit event and the ChildProcess 'error' event, and only for the CURRENT
     process: after a failed boot the half-started child is killed and its
     exit can land after a retry has already spawned a healthy replacement;
     flushing for the dead one would reject the retry's initialize and get
     that new child killed in turn. */
  private flushFor(proc: ChildProcess, err: Error) {
    if (this.proc !== proc) return;
    /* every rejected entry clears its own timer in the wrapper below */
    for (const p of this.pending.values()) p.rej(err);
    this.pending.clear();
    /* the server took its sessions with it — these handlers are stale, and
       leaving them would refuse the re-registration a resume needs */
    this.sessionHandlers.clear();
    this.sessionClaims.clear();
    this.proc = null;
    this.ready = null;
    /* tell the sessions AFTER the maps are cleared, and DEFERRED past the
       microtask drain: a rejected session/prompt settles through a
       .then().catch() chain (two microtask hops) that pushes the turn's
       msg.done / llm.call.done, and the listeners close the session queues —
       notifying synchronously would drop a mid-turn death's settle events
       into an already-closed queue (open bubble forever) */
    const listeners = [...this.processExitListeners];
    setImmediate(() => {
      for (const fn of listeners) {
        try {
          fn(err);
        } catch {
          /* a dying session's teardown must not take the flush down */
        }
      }
    });
  }

  /** adapters register one listener per live session handle; the return
      value unsubscribes (dispose calls it). Fired from flushFor when the
      shared server process dies. */
  onProcessExit(fn: (err: Error) => void): () => void {
    this.processExitListeners.add(fn);
    return () => {
      this.processExitListeners.delete(fn);
    };
  }

  private dispatch(rec: Frame) {
    /* server→client requests (permission prompts) carry both id and method */
    if (rec.id != null && rec.method) {
      const sid = (rec.params as { sessionId?: string } | undefined)?.sessionId;
      const handler = sid ? this.sessionHandlers.get(sid) : undefined;
      if (handler) {
        handler(rec);
      } else {
        /* never drop a request unanswered: the harness BLOCKS awaiting the
           response, and the turn call is unbudgeted by design — a dropped
           permission ask wedges the session busy forever (issue #97). An
           error answer lets the harness fail the tool call and move on. */
        this.respondError(
          rec.id!,
          `no live session ${sid ?? "(none given)"} on this client — ${rec.method} cannot be routed`,
        );
      }
      return;
    }
    if (rec.id != null && this.pending.has(String(rec.id))) {
      const p = this.pending.get(String(rec.id))!;
      this.pending.delete(String(rec.id));
      if (rec.error) p.rej(new Error(rec.error.message ?? "acp error"));
      else p.res(rec.result);
      return;
    }
    if (rec.method) {
      const sid = (rec.params as { sessionId?: string } | undefined)?.sessionId;
      if (sid) this.sessionHandlers.get(sid)?.(rec);
    }
  }

  /**
   * One JSON-RPC request. Budgeted so a wedged harness fails fast instead of
   * pending forever (issue #12). `timeoutMs` overrides the budget for this one
   * call; 0 runs it unbudgeted — the turn call does that, because a turn is as
   * long as the agent needs and budgeting it would fail every long turn and
   * lose its output.
   */
  call(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (!this.proc?.stdin) return Promise.reject(new Error("acp server not running"));
    const id = `truss-${++this.idc}`;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return new Promise((res, rej) => {
      /* TRUSS_ACP_TIMEOUT_MS shrinks the budget for tests (same idiom as
         TRUSS_DSH_BIN) so a wedge takes milliseconds, not the full default */
      const budget =
        timeoutMs ??
        this.opts.requestTimeoutMs ??
        (Number(process.env.TRUSS_ACP_TIMEOUT_MS) || ACP_DEFAULT_TIMEOUT_MS);
      const timer =
        budget > 0
          ? setTimeout(() => {
              if (!this.pending.delete(id)) return;
              rej(new Error(`acp ${method} timed out after ${Math.round(budget / 1000)}s`));
              /* A spawn-phase timeout means the process answered nothing while
                 booting it, and this.ready still points at it: every later
                 create/resume/model-switch would pay the full budget against
                 the same wedged process until truss restarted. Recycle it so
                 the next ensure() boots fresh — but only when nothing else is
                 on this process. A registered session (its frame handler) or
                 another call in flight means the process is shared, and
                 killing it would take healthy sessions down with the wedged
                 one. */
              const spawnPhase = method === "initialize" || method === "session/new" || method === "session/resume";
              if (spawnPhase && this.sessionHandlers.size === 0 && this.pending.size === 0) {
                try {
                  this.proc?.kill("SIGKILL");
                } catch {
                  /* already gone */
                }
                /* forget the process here rather than at its exit event: the
                   SIGKILL and the exit event are not atomic, and an ensure()
                   arriving between them would be handed this dying boot and
                   write its first request into a pipe with no reader — a
                   spawn a retry would have carried, failed. The exit handler
                   skips it (this.proc no longer matches) and has nothing left
                   to flush: both guards above were already empty. */
                this.proc = null;
                this.ready = null;
              }
            }, budget)
          : null;
      /* timeouts are failure signaling, not a reason to hold the loop open */
      timer?.unref?.();
      this.pending.set(id, {
        res: (v: unknown) => {
          if (timer) clearTimeout(timer);
          res(v);
        },
        rej: (e: Error) => {
          if (timer) clearTimeout(timer);
          rej(e);
        },
      });
    });
  }

  respond(id: string | number, result: unknown) {
    this.proc?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }

  /** answer a server→client request with an error (the unroutable path) */
  respondError(id: string | number, message: string) {
    this.proc?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }) + "\n");
  }

  onSession(dshSessionId: string, fn: SessionHandler) {
    /* first live registration wins: sessions multiplex on this one client
       keyed by the harness session id, and resume/respawn reuse the stored
       ref — so a spawn that outlived the spawn budget lands after a retry
       has already gone live on the same id. Re-registering over the live
       handler would steal the session's frames, and the abandoned spawn's
       dispose would then close the live session out from under it (issue
       #12). */
    if (this.sessionHandlers.has(dshSessionId)) {
      /* refused — but the retry is live the moment its spawn returns, so
         remember it: the owner's dispose is what frees this key, and freeing
         must hand the key on rather than leave the retry with no handler */
      const claims = this.sessionClaims.get(dshSessionId) ?? [];
      claims.push(fn);
      this.sessionClaims.set(dshSessionId, claims);
      return;
    }
    this.sessionClaims.delete(dshSessionId);
    this.sessionHandlers.set(dshSessionId, fn);
  }

  /** fn is done with this session. As the owner it frees the key, handing it
     to the earliest claimant a refused registration left waiting; as a
     refused claimant it only drops its own claim, so a closing queue is
     never handed the key later. Without the hand-off, the abandonment race
     could free the key right after a retry's registration was refused and
     leave that live retry with no handler — every frame for the session
     silently dropped (issue #12). */
  offSession(dshSessionId: string, fn: SessionHandler) {
    if (this.sessionHandlers.get(dshSessionId) === fn) {
      this.sessionHandlers.delete(dshSessionId);
      const claims = this.sessionClaims.get(dshSessionId) ?? [];
      const next = claims.shift();
      if (next) this.sessionHandlers.set(dshSessionId, next);
      /* only drop the entry once the queue is drained — deleting it here
         would orphan the claimants still waiting behind the one handed the
         key, and they would go deaf with no claim to be rescued by */
      if (!claims.length) this.sessionClaims.delete(dshSessionId);
      return;
    }
    const claims = this.sessionClaims.get(dshSessionId);
    if (!claims) return;
    const at = claims.indexOf(fn);
    if (at !== -1) claims.splice(at, 1);
    if (!claims.length) this.sessionClaims.delete(dshSessionId);
  }

  /** is fn still the handler registered for this session? Sessions multiplex
     on one client keyed by the harness session id, and resume/respawn reuse
     the stored ref — so a spawn that outlived the spawn budget can settle
     after a retry has already gone live on the same key. Its late teardown
     must stop here, or it deletes the live session's handler and every
     frame for that session is silently dropped (issue #12). */
  ownsSession(dshSessionId: string, fn: SessionHandler) {
    return this.sessionHandlers.get(dshSessionId) === fn;
  }
}

/* ── per-session state + the standard event mapping ── */

/**
 * Teardown every ACP adapter's dispose shares — hermes and dsh both hand this
 * their handle, so the ownership guard exists once and can't drift between
 * the two copies.
 *
 * Sessions multiplex on one shared client keyed by the harness session id,
 * and resume/respawn reuse the stored ref — a spawn that outlived the spawn
 * budget can land after a retry has gone live on the same key, and its late
 * teardown must not close the live session out from under it (issue #12).
 * The other ordering is the sharper one: when the abandoned spawn is the
 * FIRST to register it owns the key and ownsSession alone would let the close
 * through — so a handle the spawn budget gave up on never closes the harness
 * session it resumed. The retry is bringing that same session back, and the
 * next resume reclaims it.
 */
export function disposeAcpSession(client: AcpClient, h: AcpSessionState) {
  const owned = Boolean(h.onFrame && client.ownsSession(h.acpSessionId, h.onFrame));
  /* stop hearing process exits — a disposed session's queue is closing
     below, and a later exit must not push into it */
  h.offProcessExit?.();
  h.offProcessExit = null;
  /* offSession even when the key was never ours: a registration that was
     refused leaves a claim behind, and a handle going away must not leave
     the client ready to hand the key to a queue that is about to close */
  if (h.onFrame) client.offSession(h.acpSessionId, h.onFrame);
  if (owned && !(h.abandoned && h.resumed)) {
    void client.call("session/close", { sessionId: h.acpSessionId }).catch(() => undefined);
  }
  h.queue.close();
}

export class AsyncQueue<T> {
  private buf: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private done = false;
  push(item: T) {
    if (this.done) return;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.buf.push(item);
  }
  close() {
    this.done = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const head = this.buf.shift();
        if (head !== undefined) return Promise.resolve({ value: head, done: false });
        if (this.done) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((res) => this.waiters.push(res));
      },
    };
  }
}

export interface AcpSessionState extends AdapterHandle {
  acpSessionId: string;
  queue: AsyncQueue<ProtoEvent>;
  busy: boolean;
  model: string;
  currentMessageId: string | null;
  turnCallId: string | null;
  turnStartedAt: number;
  toolStartedAt: Map<string, number>;
  pendingPerms: Set<string>;
  /** the handler this state registered on the shared client — dispose checks
     it still owns the key before tearing the session down */
  onFrame: SessionHandler | null;
  /** unsubscribe for the client's process-exit notification, registered at
      spawn; dispose calls it so a dead session stops hearing process exits */
  offProcessExit: (() => void) | null;
  /** text content streamed so far this turn — an instant settle with zero
      text is the ghost black hole (issue #97), never a silent success */
  turnTextChars: number;
  /** the harness session came from the stored resume ref rather than a fresh
     session/new, so it is shared with any retry that resumes the same ref */
  resumed: boolean;
}

export function makeSessionState(sessionId: string, acpSessionId: string, model: string): AcpSessionState {
  return {
    sessionId,
    acpSessionId,
    queue: new AsyncQueue<ProtoEvent>(),
    busy: false,
    model,
    currentMessageId: null,
    turnCallId: null,
    turnStartedAt: 0,
    toolStartedAt: new Map(),
    pendingPerms: new Set(),
    onFrame: null,
    offProcessExit: null,
    turnTextChars: 0,
    resumed: false,
  };
}

/**
 * The standard ACP session/update → proto mapping.
 * Returns the tokens from the prompt settle for callers that surface them.
 */
export function handleAcpUpdate(h: AcpSessionState, update: AcpUpdate) {
  const sid = h.sessionId;
  const emit = (ev: ProtoEvent) => h.queue.push(ev);

  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      if (h.currentMessageId && update.content?.text) {
        h.turnTextChars += update.content.text.length;
        emit({
          type: "msg.chunk",
          sessionId: sid,
          messageId: h.currentMessageId,
          text: update.content.text,
          channel: "text",
        });
      }
      break;
    }
    case "agent_thought_chunk": {
      if (h.currentMessageId && update.content?.text) {
        emit({
          type: "msg.chunk",
          sessionId: sid,
          messageId: h.currentMessageId,
          text: update.content.text,
          channel: "thinking",
        });
      }
      break;
    }
    case "tool_call": {
      const id = update.toolCallId ?? `tool-${Date.now()}`;
      h.toolStartedAt.set(id, Date.now());
      emit({
        type: "tool.call",
        sessionId: sid,
        toolCallId: id,
        name: update.title ?? update.kind ?? "tool",
        args: undefined,
        callId: h.turnCallId ?? undefined,
      });
      break;
    }
    case "tool_call_update": {
      const id = update.toolCallId;
      if (!id) break;
      const status = update.status;
      if (status === "completed" || status === "failed") {
        const started = h.toolStartedAt.get(id);
        h.toolStartedAt.delete(id);
        emit({
          type: "tool.done",
          sessionId: sid,
          toolCallId: id,
          ok: status === "completed",
          durationMs: started ? Date.now() - started : undefined,
          output:
            typeof update.rawOutput === "string"
              ? update.rawOutput
              : update.rawOutput
                ? JSON.stringify(update.rawOutput).slice(0, 4000)
                : undefined,
        });
      } else {
        emit({ type: "tool.update", sessionId: sid, toolCallId: id, status: "in_progress" });
      }
      break;
    }
    case "usage_update": {
      if (typeof update.used === "number" && typeof update.size === "number") {
        emit({ type: "ctx.usage", sessionId: sid, used: update.used, total: update.size });
      }
      break;
    }
    default:
      break; // plan / available_commands / session_info / config_option — later milestones
  }
}

/** Open one assistant message + one trajectory row for a turn. */
export function beginAcpTurn(h: AcpSessionState) {
  const sid = h.sessionId;
  h.turnCallId = `turn-${Date.now()}`;
  h.turnStartedAt = Date.now();
  h.turnTextChars = 0;
  h.currentMessageId = `m-${Date.now()}`;
  h.queue.push({ type: "session.state", sessionId: sid, state: "running" });
  h.queue.push({
    type: "llm.call.start",
    sessionId: sid,
    callId: h.turnCallId,
    model: h.model,
    at: h.turnStartedAt,
  });
  h.queue.push({
    type: "msg.start",
    sessionId: sid,
    messageId: h.currentMessageId,
    role: "assistant",
    at: Date.now(),
  });
}

/** Close the turn: message done + trajectory row (+ optional token usage). */
export function settleAcpTurn(
  h: AcpSessionState,
  outcome: { ok: boolean; detail?: string; tokensIn?: number; tokensOut?: number },
) {
  const sid = h.sessionId;
  if (h.currentMessageId) {
    h.queue.push({
      type: "msg.done",
      sessionId: sid,
      messageId: h.currentMessageId,
      stopReason: outcome.ok ? undefined : `error: ${outcome.detail ?? "unknown"}`,
    });
    h.currentMessageId = null;
  }
  if (h.turnCallId) {
    h.queue.push({
      type: "llm.call.done",
      sessionId: sid,
      callId: h.turnCallId,
      status: outcome.ok ? 200 : 500,
      latencyMs: Date.now() - h.turnStartedAt,
      tokensIn: outcome.tokensIn,
      tokensOut: outcome.tokensOut,
    });
    h.turnCallId = null;
  }
  h.busy = false;
  h.queue.push({ type: "session.state", sessionId: sid, state: "idle" });
}

/**
 * A prompt settle under this many milliseconds with zero streamed text is the
 * ghost black hole: the harness answered a session it does not have with a
 * fake instant success (probe evidence in issue #97 — 13-55ms, no content).
 * The bar sits far under any real model round trip; real turns stream text
 * or take real time, and both are untouched.
 */
export const GHOST_SETTLE_MS = 100;

/**
 * Read the session/prompt result and decide whether the turn really ran.
 * ACP settlements are silent-success shaped by default — hermes-acp answers
 * prompts for dead sessions with an instant `{"stopReason":"refusal"}` and
 * no error, so settling `ok: true` on any resolution renders the chat alive
 * while nothing works. Both ghost shapes become loud failures: the
 * trajectory row gets a failure status and the transcript says why.
 */
export function classifyAcpSettle(
  h: AcpSessionState,
  result: unknown,
): { ok: boolean; detail?: string } {
  const stopReason = (result as { stopReason?: string } | null)?.stopReason;
  if (stopReason === "refusal") {
    /* a refusal on a HEALTHY session is the model declining; on a dead one
       it is the ghost ACK. The wording covers both; the failure is loud
       either way and the session stays usable */
    return {
      ok: false,
      detail: "refused: the harness refused the turn or never engaged (its session may be gone; resend to resume)",
    };
  }
  if (h.turnTextChars === 0 && Date.now() - h.turnStartedAt < GHOST_SETTLE_MS) {
    return { ok: false, detail: "empty: the harness returned nothing" };
  }
  return { ok: true };
}

/** The busy-guard message adapters share when a second prompt arrives mid-turn. */
export function busyNote(h: AcpSessionState, harnessName: string) {
  const id = `m-sys-${Date.now()}`;
  h.queue.push({ type: "msg.start", sessionId: h.sessionId, messageId: id, role: "system", at: Date.now() });
  h.queue.push({
    type: "msg.chunk",
    sessionId: h.sessionId,
    messageId: id,
    text: `${harnessName} settles one turn at a time — wait for the current run to finish`,
  });
  h.queue.push({ type: "msg.done", sessionId: h.sessionId, messageId: id });
}
