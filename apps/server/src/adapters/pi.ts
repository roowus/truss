import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProtoEvent } from "@truss/proto";
import type { AdapterHandle, HarnessAdapter, SessionOpts } from "./types.js";
import { cwdFallbackNote, resolveCwd } from "./types.js";

/**
 * pi adapter — drives `pi --mode rpc` (JSONL over stdin/stdout).
 * Refs: vendor/pi-mono/packages/coding-agent/docs/rpc.md, json.md, rpc-commands.md
 *
 * Framing: strict LF-delimited JSON. Node readline is NOT safe (splits on
 * U+2028/U+2029 which are valid inside JSON strings) — we split bytes on LF.
 */

interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { total?: number };
}

interface PiRecord {
  type: string;
  id?: string;
  command?: string;
  success?: boolean;
  error?: string;
  data?: Record<string, unknown>;
  message?: { role?: string; content?: unknown; stopReason?: string; errorMessage?: string };
  usage?: PiUsage;
  assistantMessageEvent?: {
    type: string;
    contentIndex?: number;
    delta?: string;
    content?: string;
    reason?: string;
    error?: unknown;
    id?: string;
    toolName?: string;
    toolCall?: { id?: string; name?: string; arguments?: unknown };
  };
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  partialResult?: { content?: { type: string; text?: string }[] };
  result?: { content?: { type: string; text?: string }[] };
  isError?: boolean;
  willRetry?: boolean;
  attempt?: number;
  maxAttempts?: number;
  delayMs?: number;
  errorMessage?: string;
  finalError?: string;
  name?: string;
}

interface PiHandle extends AdapterHandle {
  proc: ChildProcess;
  queue: AsyncQueue<ProtoEvent>;
  busy: boolean;
  contextWindow: number;
  model: string;
  /** pi command-id → resolver (get_state etc.) */
  pending: Map<string, (rec: PiRecord) => void>;
  /** per-process id prefix — after a resume the counters restart and old
      message/call ids are already persisted, so ids must be unique per spawn */
  idPrefix: string;
  msgCounter: number;
  turnCounter: number;
  currentMessageId: string | null;
  currentCallId: string | null;
  currentCallStartedAt: number;
  /** trajectory row status for the open call — message_end flips it on
      provider errors (500) and aborts (499) so failed turns stop looking
      successful in the trajectory */
  currentCallStatus: number;
  latestUsage: PiUsage | null;
  toolStartedAt: Map<string, number>;
  /** retryCallId → failedCallId linkage for trajectory retry rows */
  retryOf: Map<string, string>;
  /** set when the user aborts — suppresses the error pair pi emits afterwards */
  aborting: boolean;
  disposed: boolean;
}

/** Minimal push-based async queue feeding the events() iterable. */
class AsyncQueue<T> {
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

function textOf(content: { type: string; text?: string }[] | undefined): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

export function readPiModels(): { provider: string; model: string; label: string; contextWindow?: number }[] {
  const path = join(homedir(), ".pi", "agent", "models.json");
  if (!existsSync(path)) return [];
  try {
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    const out: { provider: string; model: string; label: string; contextWindow?: number }[] = [];
    for (const [provider, p] of Object.entries<any>(cfg.providers ?? {})) {
      for (const m of p.models ?? []) {
        out.push({
          provider,
          model: m.id,
          label: m.name ?? `${provider}/${m.id}`,
          contextWindow: m.contextWindow,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export const piAdapter: HarnessAdapter = {
  id: "pi",
  capabilities: { permissions: false, subagents: false, streaming: true, queueWhileRunning: true },

  async listModels() {
    return readPiModels();
  },

  async spawn(opts: SessionOpts): Promise<PiHandle> {
    /* model without provider (sessions stored before provider persisted)
       resolves through the catalog — a bare default would send e.g. a
       fireworks model id to the zai endpoint: 400 Unknown Model */
    const catalog = readPiModels();
    const model = opts.model ?? "glm-4.7";
    const provider =
      opts.provider ??
      (opts.model ? catalog.find((m) => m.model === opts.model)?.provider : undefined) ??
      "zai-local";
    /* sessions persist under the truss data dir so a server restart can resume them */
    const here = dirname(fileURLToPath(import.meta.url));
    const sessionDir = join(process.env.TRUSS_DATA_DIR ?? join(here, "..", "..", "data"), "pi-sessions");
    mkdirSync(sessionDir, { recursive: true });

    /* a deleted cwd kills spawn with ENOENT — fall back to ~ and say so.
       resume needs the session's own directory: pi interactively asks to
       fork when it differs (auto-aborts headless), so a fallen-back cwd
       starts fresh and keeps the transcript visible instead. */
    const { cwd: safeCwd, fellBack: cwdFellBack } = resolveCwd(opts.cwd);
    const canResumeInPlace = !!opts.resumeRef && !cwdFellBack;
    const args = ["--mode", "rpc", "--session-dir", sessionDir, "--provider", provider, "--model", model];
    if (canResumeInPlace && opts.resumeRef) args.push("--session", opts.resumeRef);
    const proc = spawn("pi", args, {
      cwd: safeCwd,
      stdio: ["pipe", "pipe", "inherit"], // stderr is diagnostics, never protocol
      env: { ...process.env },
    });

    const h: PiHandle = {
      sessionId: opts.sessionId,
      proc,
      queue: new AsyncQueue<ProtoEvent>(),
      busy: false,
      contextWindow:
        catalog.find((m) => m.provider === provider && m.model === model)?.contextWindow ?? 200_000,
      model,
      pending: new Map(),
      idPrefix: `${Date.now().toString(36)}-`,
      msgCounter: 0,
      turnCounter: 0,
      currentMessageId: null,
      currentCallId: null,
      currentCallStartedAt: 0,
      currentCallStatus: 200,
      latestUsage: null,
      toolStartedAt: new Map(),
      retryOf: new Map(),
      aborting: false,
      disposed: false,
    };

    const emit = (ev: ProtoEvent) => h.queue.push(ev);
    const sid = opts.sessionId;

    proc.on("error", (err) => {
      emit({ type: "session.state", sessionId: sid, state: "error", detail: String(err) });
      h.queue.close();
    });
    proc.on("exit", (code) => {
      if (!h.disposed) {
        emit({ type: "session.state", sessionId: sid, state: "error", detail: `pi exited (${code})` });
      }
      h.queue.close();
    });

    // LF-framed stdout reader
    let buf = "";
    proc.stdout!.setEncoding("utf8");
    proc.stdout!.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!line.trim()) continue;
        let rec: PiRecord;
        try {
          rec = JSON.parse(line);
        } catch {
          continue; // non-JSON diagnostics on stdout are not protocol; skip
        }
        handleRecord(h, rec, emit);
      }
    });

    emit({ type: "session.state", sessionId: sid, state: "idle" });
    if (cwdFellBack) {
      cwdFallbackNote(emit, sid, opts.cwd, safeCwd);
      if (opts.resumeRef) {
        const id = `m-sys-${Date.now()}-r`;
        emit({ type: "msg.start", sessionId: sid, messageId: id, role: "system", at: Date.now() });
        emit({
          type: "msg.chunk",
          sessionId: sid,
          messageId: id,
          text: "couldn't resume the old harness session without its directory — starting fresh in the fallback; the transcript above is the stored history",
        });
        emit({ type: "msg.done", sessionId: sid, messageId: id });
      }
    }

    /* learn pi's own session id for restart-resume (get_state is the rpc handshake for it) */
    const stateReqId = `truss-state-${Date.now()}`;
    let stateTimer: ReturnType<typeof setTimeout>;
    const stateRec = new Promise<PiRecord | null>((res) => {
      h.pending.set(stateReqId, (rec) => {
        clearTimeout(stateTimer); // answered — don't hold the loop open for 8s
        res(rec);
      });
      stateTimer = setTimeout(() => {
        h.pending.delete(stateReqId);
        res(null);
      }, 8000);
    });
    proc.stdin!.write(JSON.stringify({ id: stateReqId, type: "get_state" }) + "\n");
    void stateRec
      .then((rec) => {
        h.pending.delete(stateReqId);
        const sessionId = (rec?.data as { sessionId?: string } | undefined)?.sessionId;
        if (sessionId) h.harnessRef = sessionId;
      })
      .catch(() => undefined);

    return h;
  },

  send(handle: AdapterHandle, text: string) {
    const h = handle as PiHandle;
    // pi rejects a bare prompt while streaming; followUp queues it after the run.
    const cmd = h.busy
      ? { type: "follow_up", message: text }
      : { type: "prompt", message: text };
    h.proc.stdin!.write(JSON.stringify(cmd) + "\n");
  },

  interrupt(handle: AdapterHandle) {
    const h = handle as PiHandle;
    h.aborting = true;
    h.proc.stdin!.write(JSON.stringify({ type: "clear_queue" }) + "\n");
    h.proc.stdin!.write(JSON.stringify({ type: "abort" }) + "\n");
  },

  events(handle: AdapterHandle) {
    return (handle as PiHandle).queue;
  },

  dispose(handle: AdapterHandle) {
    const h = handle as PiHandle;
    h.disposed = true;
    try {
      h.proc.stdin!.end(); // orderly shutdown per rpc.md
    } catch {
      h.proc.kill("SIGTERM");
    }
  },
};

function handleRecord(h: PiHandle, rec: PiRecord, emit: (ev: ProtoEvent) => void) {
  const sid = h.sessionId;

  switch (rec.type) {
    case "response": {
      // truss-internal command correlation first (get_state, …)
      if (rec.id && h.pending.has(rec.id)) {
        h.pending.get(rec.id)!(rec);
        h.pending.delete(rec.id);
        return;
      }
      // command ack; failures of prompt surface here before acceptance
      if (rec.success === false && (rec.command === "prompt" || rec.command === "follow_up")) {
        const id = `m${h.idPrefix}${++h.msgCounter}`;
        emit({ type: "msg.start", sessionId: sid, messageId: id, role: "system", at: Date.now() });
        emit({
          type: "msg.chunk",
          sessionId: sid,
          messageId: id,
          text: `prompt rejected: ${rec.error ?? "unknown error"}`,
        });
        emit({ type: "msg.done", sessionId: sid, messageId: id, stopReason: "error" });
      }
      return;
    }

    case "agent_start": {
      h.busy = true;
      h.aborting = false;
      emit({ type: "session.state", sessionId: sid, state: "running" });
      return;
    }

    case "turn_start": {
      const callId = `call-${h.idPrefix}${++h.turnCounter}`;
      h.currentCallId = callId;
      h.currentCallStartedAt = Date.now();
      h.currentCallStatus = 200;
      h.latestUsage = null;
      emit({ type: "llm.call.start", sessionId: sid, callId, model: h.model, at: Date.now() });
      return;
    }

    case "message_start": {
      const role = rec.message?.role;
      if (role === "assistant") {
        const id = `m${h.idPrefix}${++h.msgCounter}`;
        h.currentMessageId = id;
        emit({ type: "msg.start", sessionId: sid, messageId: id, role: "assistant", at: Date.now() });
      }
      // user/system message_start are pi echoing input — the server already
      // emitted the user message locally when the prompt was accepted.
      return;
    }

    case "message_update": {
      if (rec.usage) h.latestUsage = rec.usage;
      const ev = rec.assistantMessageEvent;
      if (!ev || !h.currentMessageId) return;
      if (ev.type === "text_delta" && ev.delta) {
        emit({
          type: "msg.chunk",
          sessionId: sid,
          messageId: h.currentMessageId,
          text: ev.delta,
          channel: "text",
        });
      } else if (ev.type === "thinking_delta" && ev.delta) {
        emit({
          type: "msg.chunk",
          sessionId: sid,
          messageId: h.currentMessageId,
          text: ev.delta,
          channel: "thinking",
        });
      } else if (ev.type === "error") {
        if (h.aborting) return; // expected after user abort
        emit({
          type: "msg.done",
          sessionId: sid,
          messageId: h.currentMessageId,
          stopReason: "error",
        });
      }
      return;
    }

    case "message_end": {
      /* message_end.message is the authoritative final message (json.md) —
         provider failures (400 Unknown Model, auth, …) surface ONLY here as
         stopReason "error" + errorMessage, never as a message_update. Without
         this the bubble just closes silently and the chat looks dead. */
      const msg = rec.message;
      if (msg?.role === "assistant" && h.currentMessageId) {
        if (msg.stopReason === "error") {
          const detail = msg.errorMessage ? `: ${msg.errorMessage.slice(0, 240)}` : "";
          h.currentCallStatus = 500;
          emit({
            type: "msg.done",
            sessionId: sid,
            messageId: h.currentMessageId,
            stopReason: `error${detail}`,
          });
        } else if (msg.stopReason === "aborted") {
          h.currentCallStatus = 499;
          emit({ type: "msg.done", sessionId: sid, messageId: h.currentMessageId, stopReason: "interrupted" });
        } else {
          emit({ type: "msg.done", sessionId: sid, messageId: h.currentMessageId });
        }
        h.currentMessageId = null;
      }
      return;
    }

    case "tool_execution_start": {
      const id = rec.toolCallId ?? `tool-${Date.now()}`;
      h.toolStartedAt.set(id, Date.now());
      emit({
        type: "tool.call",
        sessionId: sid,
        toolCallId: id,
        name: rec.toolName ?? "tool",
        args: rec.args,
        callId: h.currentCallId ?? undefined,
      });
      return;
    }

    case "tool_execution_update": {
      const id = rec.toolCallId;
      if (!id) return;
      emit({
        type: "tool.update",
        sessionId: sid,
        toolCallId: id,
        status: "in_progress",
        output: textOf(rec.partialResult?.content),
      });
      return;
    }

    case "tool_execution_end": {
      const id = rec.toolCallId;
      if (!id) return;
      const started = h.toolStartedAt.get(id);
      h.toolStartedAt.delete(id);
      emit({
        type: "tool.done",
        sessionId: sid,
        toolCallId: id,
        ok: !rec.isError,
        durationMs: started ? Date.now() - started : undefined,
        output: textOf(rec.result?.content),
      });
      return;
    }

    case "turn_end": {
      if (h.currentCallId) {
        const u = h.latestUsage;
        const retryOf = h.retryOf.get(h.currentCallId);
        emit({
          type: "llm.call.done",
          sessionId: sid,
          callId: h.currentCallId,
          status: h.currentCallStatus,
          latencyMs: Date.now() - h.currentCallStartedAt,
          tokensIn: u?.input,
          tokensOut: u?.output,
          costUsd: u?.cost?.total,
          cacheRead: u?.cacheRead,
          cacheWrite: u?.cacheWrite,
          retryOf,
        });
        h.retryOf.delete(h.currentCallId);
        if (u?.totalTokens != null) {
          emit({
            type: "ctx.usage",
            sessionId: sid,
            used: u.totalTokens,
            total: h.contextWindow,
          });
        }
        h.currentCallId = null;
      }
      return;
    }

    case "auto_retry_start": {
      // close the failed call, open a retry row linked to it
      if (h.currentCallId) {
        const failedId = h.currentCallId;
        emit({
          type: "llm.call.done",
          sessionId: sid,
          callId: failedId,
          status: 500,
          latencyMs: Date.now() - h.currentCallStartedAt,
        });
        const retryId = `${failedId}-r${rec.attempt ?? 1}`;
        h.retryOf.set(retryId, failedId);
        emit({
          type: "llm.call.start",
          sessionId: sid,
          callId: retryId,
          model: h.model,
          at: Date.now(),
        });
        h.currentCallId = retryId;
        h.currentCallStartedAt = Date.now();
      }
      return;
    }

    case "auto_retry_end": {
      if (rec.success === false && rec.finalError && h.currentMessageId) {
        emit({
          type: "msg.done",
          sessionId: sid,
          messageId: h.currentMessageId,
          stopReason: `error: ${rec.finalError}`,
        });
      }
      return;
    }

    case "agent_end":
      return; // per-run; turn_end already closed the llm.call row

    case "agent_settled": {
      /* user-aborted turns can leave an assistant message open with no
         content — close it as interrupted so it doesn't stream forever */
      if (h.aborting && h.currentMessageId) {
        emit({
          type: "msg.done",
          sessionId: sid,
          messageId: h.currentMessageId,
          stopReason: "interrupted",
        });
        h.currentMessageId = null;
      }
      if (h.aborting && h.currentCallId) {
        emit({
          type: "llm.call.done",
          sessionId: sid,
          callId: h.currentCallId,
          status: 499,
          latencyMs: Date.now() - h.currentCallStartedAt,
        });
        h.currentCallId = null;
      }
      h.busy = false;
      h.aborting = false;
      emit({ type: "session.state", sessionId: sid, state: "idle" });
      return;
    }

    default:
      return; // queue_update, compaction_*, extension records — M2+
  }
}
