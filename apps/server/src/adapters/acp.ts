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
  private ready: Promise<void> | null = null;
  private exitListenersAttached = false;

  constructor(
    private launch: AcpLaunchSpec,
    private opts: { requestTimeoutMs?: number } = {},
  ) {}

  async ensure(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const proc = spawn(this.launch.command, this.launch.args, {
        stdio: ["pipe", "pipe", "inherit"], // stderr is diagnostics, never protocol
        env: { ...process.env, ...this.launch.env },
        cwd: this.launch.cwd,
      });
      this.proc = proc;

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
        if (this.proc !== proc) return;
        /* every rejected entry clears its own timer in the wrapper below */
        for (const p of this.pending.values()) p.rej(new Error("acp server exited"));
        this.pending.clear();
        /* the server took its sessions with it — these handlers are stale,
           and leaving them would refuse the re-registration a resume needs */
        this.sessionHandlers.clear();
        this.proc = null;
        this.ready = null;
      });

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
    this.ready.catch(() => {
      this.ready = null;
    });
    return this.ready;
  }

  private dispatch(rec: Frame) {
    /* server→client requests (permission prompts) carry both id and method */
    if (rec.id != null && rec.method) {
      const sid = (rec.params as { sessionId?: string } | undefined)?.sessionId;
      if (sid) this.sessionHandlers.get(sid)?.(rec);
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
      const budget = timeoutMs ?? this.opts.requestTimeoutMs ?? ACP_DEFAULT_TIMEOUT_MS;
      const timer =
        budget > 0
          ? setTimeout(() => {
              if (this.pending.delete(id)) rej(new Error(`acp ${method} timed out after ${Math.round(budget / 1000)}s`));
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

  onSession(dshSessionId: string, fn: SessionHandler) {
    /* first live registration wins: sessions multiplex on this one client
       keyed by the harness session id, and resume/respawn reuse the stored
       ref — so a spawn that outlived the spawn budget lands after a retry
       has already gone live on the same id. Re-registering over the live
       handler would steal the session's frames, and the abandoned spawn's
       dispose would then close the live session out from under it (issue
       #12). */
    if (this.sessionHandlers.has(dshSessionId)) return;
    this.sessionHandlers.set(dshSessionId, fn);
  }

  offSession(dshSessionId: string) {
    this.sessionHandlers.delete(dshSessionId);
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
