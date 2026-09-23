import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProtoEvent } from "@truss/proto";
import type { AdapterHandle, HarnessAdapter, SessionOpts } from "./types.js";

/**
 * DeepSeek Harness adapter — ACP (JSON-RPC 2.0, NDJSON over stdio).
 *
 * `dsh --profile acp` multiplexes many sessions over one stdio connection,
 * so this adapter keeps ONE server process per Truss server and opens a
 * dsh session per Truss session via session/new.
 *
 * ACP carries committed updates (no token deltas): one assistant message per
 * turn, chunked; tool lifecycle; usage_update for context occupancy.
 * No per-LLM-call telemetry exists on the wire — trajectory rows are
 * per-turn with latency only.
 *
 * Refs: vendor/deepseek-harness/packages/acp/acp/README.md (contract)
 */

const here = dirname(fileURLToPath(import.meta.url));
const PATCH = process.env.TRUSS_DSH_PATCH ?? join(here, "..", "..", "..", "..", "config", "truss-dsh-acp.yml");
const DSH_ENV_FILE = process.env.DSH_ENV_FILE ?? "/opt/dsh/.env";

/* ── ACP wire types (only what Truss uses) ── */

interface AcpContent {
  type: string;
  text?: string;
}

interface AcpUpdate {
  sessionUpdate: string;
  content?: AcpContent;
  title?: string;
  toolCallId?: string;
  status?: string;
  kind?: string;
  rawOutput?: unknown;
  content0?: unknown;
  used?: number;
  size?: number;
  /** tool_call_update content array */
  content2?: unknown;
}

interface AcpOption {
  value: string;
  name: string;
  description?: string;
}
interface AcpOptionGroup {
  group: string;
  options?: AcpOption[];
}
interface AcpConfigOption {
  id: string;
  type: string;
  currentValue?: string;
  options?: (AcpOption | AcpOptionGroup)[];
}

interface DshHandle extends AdapterHandle {
  dshSessionId: string;
  queue: AsyncQueue<ProtoEvent>;
  busy: boolean;
  model: string;
  currentMessageId: string | null;
  turnCallId: string | null;
  turnStartedAt: number;
  toolStartedAt: Map<string, number>;
  pendingPerms: Set<string>;
  contextWindow: number;
}

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

/* ── the shared dsh-acp connection ── */

class DshConnection {
  proc: ChildProcess | null = null;
  private buf = "";
  private idc = 0;
  private pending = new Map<string, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  private sessionHandlers = new Map<string, (rec: { method: string; params?: Record<string, unknown>; id?: string }) => void>();
  ready: Promise<void> | null = null;
  onExit: (() => void) | null = null;

  private loadEnv(): Record<string, string> {
    const env = { ...process.env } as Record<string, string>;
    try {
      for (const line of readFileSync(DSH_ENV_FILE, "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
        if (m) env[m[1]] = m[2];
      }
    } catch {
      /* env file optional */
    }
    return env;
  }

  async ensure(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const proc = spawn("dsh", ["--profile", "acp", "--patch", PATCH], {
        stdio: ["pipe", "pipe", "inherit"],
        env: this.loadEnv(),
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
          let rec: {
            id?: string;
            method?: string;
            params?: Record<string, unknown>;
            result?: unknown;
            error?: { message?: string };
          };
          try {
            rec = JSON.parse(line);
          } catch {
            continue;
          }
          this.dispatch(rec);
        }
      });

      proc.on("exit", () => {
        for (const p of this.pending.values()) p.rej(new Error("dsh-acp exited"));
        this.pending.clear();
        this.proc = null;
        this.ready = null;
        this.onExit?.();
      });

      /* never orphan the multiplexed server when the truss server goes down */
      const shutdown = () => {
        try {
          proc.stdin?.end(); // orderly ACP shutdown
        } catch {
          proc.kill("SIGTERM");
        }
      };
      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);
      process.once("exit", shutdown);
      proc.on("exit", () => {
        process.removeListener("SIGTERM", shutdown);
        process.removeListener("SIGINT", shutdown);
        process.removeListener("exit", shutdown);
      });

      const init = (await this.call("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      })) as { protocolVersion?: number };
      if (!init.protocolVersion) throw new Error("dsh-acp initialize failed");
    })();
    this.ready.catch(() => {
      this.ready = null;
    });
    return this.ready;
  }

  private dispatch(rec: {
    id?: string;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
    error?: { message?: string };
  }) {
    /* server→client requests carry both id and method (permission prompts) */
    if (rec.id && rec.method) {
      const sid = (rec.params as { sessionId?: string } | undefined)?.sessionId;
      if (sid) this.sessionHandlers.get(sid)?.(rec as never);
      return;
    }
    if (rec.id && this.pending.has(rec.id)) {
      const p = this.pending.get(rec.id)!;
      this.pending.delete(rec.id);
      if (rec.error) p.rej(new Error(rec.error.message ?? "acp error"));
      else p.res(rec.result);
      return;
    }
    if (rec.method) {
      const sid = (rec.params as { sessionId?: string } | undefined)?.sessionId;
      if (sid) this.sessionHandlers.get(sid)?.(rec as never);
    }
  }

  call(method: string, params: unknown): Promise<unknown> {
    if (!this.proc?.stdin) return Promise.reject(new Error("dsh-acp not running"));
    const id = `truss-${++this.idc}`;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return new Promise((res, rej) => {
      this.pending.set(id, { res: res as (v: unknown) => void, rej });
    });
  }

  respond(id: string, result: unknown) {
    this.proc?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }

  onSession(dshSessionId: string, fn: (rec: { method: string; params?: Record<string, unknown>; id?: string }) => void) {
    this.sessionHandlers.set(dshSessionId, fn);
  }

  offSession(dshSessionId: string) {
    this.sessionHandlers.delete(dshSessionId);
  }
}

const conn = new DshConnection();

/** pull provider/model labels out of session/new's configOptions for display */
function parseModelOptions(opts: AcpConfigOption[] | undefined): { provider: string; model: string; label: string }[] {
  const out: { provider: string; model: string; label: string }[] = [];
  const modelOpt = opts?.find((o) => o.id === "model");
  if (!modelOpt) return out;
  const walk = (o: AcpOption | AcpOptionGroup) => {
    if ("options" in o && o.options) o.options.forEach(walk);
    else if ("value" in o) {
      try {
        const [provider, model] = JSON.parse(o.value) as [string, string];
        out.push({ provider, model, label: o.name ?? model });
      } catch {
        /* non-JSON option value — skip */
      }
    }
  };
  modelOpt.options?.forEach(walk);
  return out;
}

let discoveredModels: { provider: string; model: string; label: string }[] = [];

export const dshAdapter: HarnessAdapter = {
  id: "dsh",
  capabilities: { permissions: true, subagents: false, streaming: true, queueWhileRunning: false },

  async listModels() {
    return discoveredModels;
  },

  async spawn(opts: SessionOpts): Promise<DshHandle> {
    await conn.ensure();

    const res = (await conn.call("session/new", { cwd: opts.cwd, mcpServers: [] })) as {
      sessionId: string;
      configOptions?: AcpConfigOption[];
    };

    const models = parseModelOptions(res.configOptions);
    if (models.length) discoveredModels = models;

    const model =
      models.find((m) => m.model === opts.model)?.label ?? opts.model ?? "deepseek";

    /* honor the requested model when it differs from the profile default */
    if (opts.model && models.some((m) => m.model === opts.model)) {
      const found = models.find((m) => m.model === opts.model)!;
      await conn.call("session/set_config_option", {
        sessionId: res.sessionId,
        configId: "model",
        value: JSON.stringify([found.provider, found.model]),
      }).catch(() => undefined);
    }

    const h: DshHandle = {
      sessionId: opts.sessionId,
      dshSessionId: res.sessionId,
      queue: new AsyncQueue<ProtoEvent>(),
      busy: false,
      model,
      currentMessageId: null,
      turnCallId: null,
      turnStartedAt: 0,
      toolStartedAt: new Map(),
      pendingPerms: new Set(),
      contextWindow: 200_000,
    };

    conn.onSession(res.sessionId, (rec) => handleServerMessage(h, rec));
    h.queue.push({ type: "session.state", sessionId: opts.sessionId, state: "idle" });
    return h;
  },

  send(handle: AdapterHandle, text: string) {
    const h = handle as DshHandle;
    /* ACP: one prompt at a time per session — no steer/follow-up queue */
    if (h.busy) {
      const id = `m-sys-${Date.now()}`;
      h.queue.push({ type: "msg.start", sessionId: h.sessionId, messageId: id, role: "system", at: Date.now() });
      h.queue.push({
        type: "msg.chunk",
        sessionId: h.sessionId,
        messageId: id,
        text: "dsh settles one turn at a time — wait for the current run to finish",
      });
      h.queue.push({ type: "msg.done", sessionId: h.sessionId, messageId: id });
      return;
    }
    h.busy = true;
    h.turnCallId = `turn-${Date.now()}`;
    h.turnStartedAt = Date.now();
    h.currentMessageId = `m-${Date.now()}`;
    const sid = h.sessionId;

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

    void conn
      .call("session/prompt", {
        sessionId: h.dshSessionId,
        prompt: [{ type: "text", text }],
      })
      .then(() => {
        /* settled: close message + trajectory row */
        if (h.currentMessageId) {
          h.queue.push({ type: "msg.done", sessionId: sid, messageId: h.currentMessageId });
          h.currentMessageId = null;
        }
        if (h.turnCallId) {
          h.queue.push({
            type: "llm.call.done",
            sessionId: sid,
            callId: h.turnCallId,
            status: 200,
            latencyMs: Date.now() - h.turnStartedAt,
          });
          h.turnCallId = null;
        }
        h.busy = false;
        h.queue.push({ type: "session.state", sessionId: sid, state: "idle" });
      })
      .catch((err: Error) => {
        if (h.currentMessageId) {
          h.queue.push({
            type: "msg.done",
            sessionId: sid,
            messageId: h.currentMessageId,
            stopReason: `error: ${err.message}`,
          });
          h.currentMessageId = null;
        }
        if (h.turnCallId) {
          h.queue.push({
            type: "llm.call.done",
            sessionId: sid,
            callId: h.turnCallId,
            status: 500,
            latencyMs: Date.now() - h.turnStartedAt,
          });
          h.turnCallId = null;
        }
        h.busy = false;
        h.queue.push({ type: "session.state", sessionId: sid, state: "idle" });
      });
  },

  interrupt(handle: AdapterHandle) {
    const h = handle as DshHandle;
    void conn.call("session/cancel", { sessionId: h.dshSessionId }).catch(() => undefined);
  },

  /** answer a permission card (server→client ACP request) */
  resolve(handle: AdapterHandle, requestId: string, choice: string) {
    const h = handle as DshHandle;
    if (!h.pendingPerms.has(requestId)) return;
    h.pendingPerms.delete(requestId);
    conn.respond(requestId, { outcome: { outcome: "selected", optionId: choice } });
  },

  events(handle: AdapterHandle) {
    return (handle as DshHandle).queue;
  },

  dispose(handle: AdapterHandle) {
    const h = handle as DshHandle;
    conn.offSession(h.dshSessionId);
    void conn.call("session/close", { sessionId: h.dshSessionId }).catch(() => undefined);
    h.queue.close();
  },
} as HarnessAdapter & { resolve(handle: AdapterHandle, requestId: string, choice: string): void };

function handleServerMessage(
  h: DshHandle,
  rec: { method: string; params?: Record<string, unknown>; id?: string },
) {
  const sid = h.sessionId;
  const emit = (ev: ProtoEvent) => h.queue.push(ev);

  if (rec.method === "session/request_permission") {
    const p = rec.params as {
      toolCall?: { title?: string; kind?: string };
      options?: { optionId: string; name: string }[];
    };
    const requestId = rec.id!;
    h.pendingPerms.add(requestId);
    emit({
      type: "perm.request",
      sessionId: sid,
      requestId,
      tool: p?.toolCall?.title ?? "tool",
      reason: p?.toolCall?.kind ?? "",
      options: (p?.options ?? []).map((o) => o.optionId),
    });
    return;
  }

  if (rec.method !== "session/update") return;
  const u = (rec.params as { update: AcpUpdate }).update;
  if (!u) return;

  switch (u.sessionUpdate) {
    case "agent_message_chunk": {
      if (h.currentMessageId && u.content?.text) {
        emit({
          type: "msg.chunk",
          sessionId: sid,
          messageId: h.currentMessageId,
          text: u.content.text,
          channel: "text",
        });
      }
      break;
    }
    case "agent_thought_chunk": {
      if (h.currentMessageId && u.content?.text) {
        emit({
          type: "msg.chunk",
          sessionId: sid,
          messageId: h.currentMessageId,
          text: u.content.text,
          channel: "thinking",
        });
      }
      break;
    }
    case "tool_call": {
      const id = u.toolCallId ?? `tool-${Date.now()}`;
      h.toolStartedAt.set(id, Date.now());
      emit({
        type: "tool.call",
        sessionId: sid,
        toolCallId: id,
        name: u.title ?? u.kind ?? "tool",
        args: undefined,
        callId: h.turnCallId ?? undefined,
      });
      break;
    }
    case "tool_call_update": {
      const id = u.toolCallId;
      if (!id) break;
      const status = u.status;
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
            typeof u.rawOutput === "string"
              ? u.rawOutput
              : u.rawOutput
                ? JSON.stringify(u.rawOutput).slice(0, 4000)
                : undefined,
        });
      } else {
        emit({ type: "tool.update", sessionId: sid, toolCallId: id, status: "in_progress" });
      }
      break;
    }
    case "usage_update": {
      if (typeof u.used === "number" && typeof u.size === "number") {
        h.contextWindow = u.size;
        emit({ type: "ctx.usage", sessionId: sid, used: u.used, total: u.size });
      }
      break;
    }
    default:
      break; // config_option_update, plan, etc. — later milestones
  }
}
