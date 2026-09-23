import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProtoEvent } from "@truss/proto";
import type { AdapterHandle, HarnessAdapter, SessionOpts } from "./types.js";

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
  message?: { role?: string; content?: unknown };
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
  msgCounter: number;
  turnCounter: number;
  currentMessageId: string | null;
  currentCallId: string | null;
  currentCallStartedAt: number;
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
  capabilities: { permissions: false, subagents: false, streaming: true },

  async listModels() {
    return readPiModels();
  },

  async spawn(opts: SessionOpts): Promise<PiHandle> {
    const provider = opts.provider ?? "zai-local";
    const model = opts.model ?? "glm-4.7";
    const args = ["--mode", "rpc", "--no-session", "--provider", provider, "--model", model];
    const proc = spawn("pi", args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "inherit"], // stderr is diagnostics, never protocol
      env: { ...process.env },
    });

    const h: PiHandle = {
      sessionId: opts.sessionId,
      proc,
      queue: new AsyncQueue<ProtoEvent>(),
      busy: false,
      contextWindow:
        readPiModels().find((m) => m.provider === provider && m.model === model)?.contextWindow ?? 200_000,
      model,
      msgCounter: 0,
      turnCounter: 0,
      currentMessageId: null,
      currentCallId: null,
      currentCallStartedAt: 0,
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
    case "response":
      // command ack; failures of prompt surface here before acceptance
      if (rec.success === false && (rec.command === "prompt" || rec.command === "follow_up")) {
        const id = `m${++h.msgCounter}`;
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

    case "agent_start": {
      h.busy = true;
      h.aborting = false;
      emit({ type: "session.state", sessionId: sid, state: "running" });
      return;
    }

    case "turn_start": {
      const callId = `call-${++h.turnCounter}`;
      h.currentCallId = callId;
      h.currentCallStartedAt = Date.now();
      h.latestUsage = null;
      emit({ type: "llm.call.start", sessionId: sid, callId, model: h.model, at: Date.now() });
      return;
    }

    case "message_start": {
      const role = rec.message?.role;
      if (role === "assistant") {
        const id = `m${++h.msgCounter}`;
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
      if (rec.message?.role === "assistant" && h.currentMessageId) {
        emit({ type: "msg.done", sessionId: sid, messageId: h.currentMessageId });
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
          status: 200,
          latencyMs: Date.now() - h.currentCallStartedAt,
          tokensIn: u?.input,
          tokensOut: u?.output,
          costUsd: u?.cost?.total,
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
      h.busy = false;
      h.aborting = false;
      emit({ type: "session.state", sessionId: sid, state: "idle" });
      return;
    }

    default:
      return; // queue_update, compaction_*, extension records — M2+
  }
}
