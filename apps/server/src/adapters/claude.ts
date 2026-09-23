import { spawn, type ChildProcess } from "node:child_process";
import type { ProtoEvent } from "@truss/proto";
import type { AdapterHandle, HarnessAdapter, SessionOpts } from "./types.js";

/**
 * Claude Code adapter — bidirectional stream-json over stdio.
 *
 * `claude -p --input-format stream-json --output-format stream-json --verbose`
 * keeps one long-lived process per session: user messages go in as JSONL,
 * assistant/result events come out as JSONL. LF-framed (U+2028-safe).
 *
 * Permission host: `--permission-prompt-tool mcp__truss_perms__approval`
 * routes approval asks to a Streamable-HTTP MCP endpoint the Truss server
 * hosts itself (/mcp/perm/:sessionId) — no helper process, no IPC.
 *
 * Models run through the dsh-key-proxy Anthropic-compatible route by default
 * (z.ai GLM): ANTHROPIC_BASE_URL=http://127.0.0.1:45821/api/anthropic with a
 * placeholder token — the proxy injects the real key, the harness never holds it.
 */

const ANTHROPIC_BASE_URL =
  process.env.TRUSS_CLAUDE_BASE_URL ?? "http://127.0.0.1:45821/api/anthropic";
const DEFAULT_MODEL = process.env.TRUSS_CLAUDE_MODEL ?? "glm-4.7";
const MCP_BASE = process.env.TRUSS_MCP_BASE ?? "http://127.0.0.1:4040";

export const CLAUDE_MODELS = [
  { provider: "zai-local", model: "glm-4.7", label: "GLM 4.7 (z.ai via key-proxy)" },
  { provider: "zai-local", model: "glm-4.6", label: "GLM 4.6 (z.ai via key-proxy)" },
  { provider: "zai-local", model: "glm-4.5", label: "GLM 4.5 (z.ai via key-proxy)" },
];

interface ClaudeContent {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface ClaudeEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  message?:
    | string
    | {
        role?: string;
        model?: string;
        content?: ClaudeContent[] | string;
        stop_reason?: string | null;
      };
  tool_name?: string;
  tool_use_id?: string;
  decision_reason?: string;
  result?: string | { role?: string };
  total_cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface ClaudeHandle extends AdapterHandle {
  proc: ChildProcess;
  queue: AsyncQueue<ProtoEvent>;
  busy: boolean;
  model: string;
  claudeSessionId: string | null;
  /** current turn */
  currentMessageId: string | null;
  turnCallId: string | null;
  turnStartedAt: number;
  toolStartedAt: Map<string, number>;
  toolNames: Map<string, string>;
  /** permission round-trips answered through the MCP host */
  pendingPerms: Map<string, (choice: string) => void>;
  disposed: boolean;
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

/** sessionId → handle, so the MCP permission route can find its session */
const permRegistry = new Map<string, ClaudeHandle>();

/**
 * Called by the server's MCP route when claude asks for approval.
 * Emits perm.request and resolves when the user answers (perm.resolve).
 */
export function claudePermissionAsk(
  sessionId: string,
  toolName: string,
  input: unknown,
  reason: string,
): Promise<string> {
  const h = permRegistry.get(sessionId);
  if (!h) return Promise.resolve("reject");
  return new Promise((resolve) => {
    const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    h.pendingPerms.set(requestId, resolve);
    h.queue.push({
      type: "perm.request",
      sessionId,
      requestId,
      tool: toolName,
      reason,
      options: ["allow", "deny"],
    });
    // the UI answering is the only path; a dead process settles as reject
    h.proc.once("exit", () => resolve("deny"));
  });
}

function resolvePerm(h: ClaudeHandle, requestId: string, choice: string): boolean {
  const fn = h.pendingPerms.get(requestId);
  if (!fn) return false;
  h.pendingPerms.delete(requestId);
  fn(choice);
  return true;
}

export const claudeAdapter: HarnessAdapter = {
  id: "claude-code",
  capabilities: { permissions: true, subagents: true, streaming: true, queueWhileRunning: false },

  async listModels() {
    return CLAUDE_MODELS;
  },

  async spawn(opts: SessionOpts): Promise<ClaudeHandle> {
    const model = opts.model ?? DEFAULT_MODEL;
    const mcpConfig = JSON.stringify({
      mcpServers: {
        truss_perms: { type: "http", url: `${MCP_BASE}/mcp/perm/${opts.sessionId}` },
      },
    });

    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-prompt-tool",
      "mcp__truss_perms__approval",
      "--mcp-config",
      mcpConfig,
      "--model",
      model,
    ];
    if (opts.resumeRef) args.push("--resume", opts.resumeRef);

    const proc = spawn("claude", args, {
        cwd: opts.cwd,
        stdio: ["pipe", "pipe", "inherit"],
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL,
          ANTHROPIC_AUTH_TOKEN: "truss-key-proxy",
          ANTHROPIC_MODEL: model,
        },
      },
    );

    const h: ClaudeHandle = {
      sessionId: opts.sessionId,
      proc,
      queue: new AsyncQueue<ProtoEvent>(),
      busy: false,
      model,
      claudeSessionId: null,
      currentMessageId: null,
      turnCallId: null,
      turnStartedAt: 0,
      toolStartedAt: new Map(),
      toolNames: new Map(),
      pendingPerms: new Map(),
      disposed: false,
    };
    permRegistry.set(opts.sessionId, h);

    const sid = opts.sessionId;
    const emit = (ev: ProtoEvent) => h.queue.push(ev);

    proc.on("error", (err) => {
      emit({ type: "session.state", sessionId: sid, state: "error", detail: String(err) });
      h.queue.close();
    });
    proc.on("exit", (code) => {
      for (const fn of h.pendingPerms.values()) fn("deny");
      h.pendingPerms.clear();
      permRegistry.delete(sid);
      if (!h.disposed) {
        emit({ type: "session.state", sessionId: sid, state: "error", detail: `claude exited (${code})` });
      }
      h.queue.close();
    });

    /* LF-framed stdout reader */
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
        let rec: ClaudeEvent;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        handleEvent(h, rec, emit);
      }
    });

    emit({ type: "session.state", sessionId: sid, state: "idle" });

    /* claude emits system.init (with session_id) only after the first prompt —
       the session manager picks harnessRef up lazily from the event pump */
    return h;
  },

  send(handle: AdapterHandle, text: string) {
    const h = handle as ClaudeHandle;
    if (h.busy) {
      const id = `m-sys-${Date.now()}`;
      h.queue.push({ type: "msg.start", sessionId: h.sessionId, messageId: id, role: "system", at: Date.now() });
      h.queue.push({
        type: "msg.chunk",
        sessionId: h.sessionId,
        messageId: id,
        text: "claude settles one turn at a time — wait for the current run to finish",
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

    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
    });
    h.proc.stdin!.write(line + "\n");
  },

  interrupt(handle: AdapterHandle) {
    const h = handle as ClaudeHandle;
    try {
      h.proc.stdin!.write(
        JSON.stringify({
          type: "control_request",
          request_id: `int-${Date.now()}`,
          request: { subtype: "interrupt" },
        }) + "\n",
      );
    } catch {
      h.proc.kill("SIGINT");
    }
  },

  resolve(handle: AdapterHandle, requestId: string, choice: string) {
    resolvePerm(handle as ClaudeHandle, requestId, choice);
  },

  events(handle: AdapterHandle) {
    return (handle as ClaudeHandle).queue;
  },

  dispose(handle: AdapterHandle) {
    const h = handle as ClaudeHandle;
    h.disposed = true;
    permRegistry.delete(h.sessionId);
    try {
      h.proc.stdin!.end();
    } catch {
      h.proc.kill("SIGTERM");
    }
  },
};

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        c && typeof c === "object" && "text" in c && typeof (c as { text?: unknown }).text === "string"
          ? (c as { text: string }).text
          : "",
      )
      .join("\n");
  }
  return "";
}

function handleEvent(h: ClaudeHandle, rec: ClaudeEvent, emit: (ev: ProtoEvent) => void) {
  const sid = h.sessionId;

  switch (rec.type) {
    case "system": {
      if (rec.subtype === "init") {
        h.claudeSessionId = rec.session_id ?? null;
        if (h.claudeSessionId) h.harnessRef = h.claudeSessionId;
        return;
      }
      if (rec.subtype === "permission_denied") {
        const id = rec.tool_use_id;
        if (id) {
          const started = h.toolStartedAt.get(id);
          h.toolStartedAt.delete(id);
          emit({
            type: "tool.done",
            sessionId: sid,
            toolCallId: id,
            ok: false,
            durationMs: started ? Date.now() - started : undefined,
            output:
              rec.decision_reason ??
              (typeof rec.message === "string" ? rec.message : undefined) ??
              "denied",
          });
        }
        return;
      }
      return; // thinking_tokens, hooks, etc.
    }

    case "assistant": {
      const msg = typeof rec.message === "object" && rec.message !== null ? rec.message : null;
      const content = msg?.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (block.type === "text" && block.text && h.currentMessageId) {
          emit({
            type: "msg.chunk",
            sessionId: sid,
            messageId: h.currentMessageId,
            text: block.text,
            channel: "text",
          });
        } else if (block.type === "thinking" && block.thinking && h.currentMessageId) {
          emit({
            type: "msg.chunk",
            sessionId: sid,
            messageId: h.currentMessageId,
            text: block.thinking,
            channel: "thinking",
          });
        } else if (block.type === "tool_use" && block.id) {
          h.toolStartedAt.set(block.id, Date.now());
          h.toolNames.set(block.id, block.name ?? "tool");
          emit({
            type: "tool.call",
            sessionId: sid,
            toolCallId: block.id,
            name: block.name ?? "tool",
            args: block.input,
            callId: h.turnCallId ?? undefined,
          });
        }
      }
      return;
    }

    case "user": {
      const msg = typeof rec.message === "object" && rec.message !== null ? rec.message : null;
      const content = msg?.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (block.type === "tool_result" && block.tool_use_id) {
          const started = h.toolStartedAt.get(block.tool_use_id);
          h.toolStartedAt.delete(block.tool_use_id);
          emit({
            type: "tool.done",
            sessionId: sid,
            toolCallId: block.tool_use_id,
            ok: !block.is_error,
            durationMs: started ? Date.now() - started : undefined,
            output: textFromContent(block.content).slice(0, 8000),
          });
        }
      }
      return;
    }

    case "result": {
      if (h.currentMessageId) {
        emit({
          type: "msg.done",
          sessionId: sid,
          messageId: h.currentMessageId,
          stopReason: rec.subtype === "success" ? undefined : rec.subtype,
        });
        h.currentMessageId = null;
      }
      if (h.turnCallId) {
        emit({
          type: "llm.call.done",
          sessionId: sid,
          callId: h.turnCallId,
          status: rec.subtype === "success" ? 200 : 500,
          latencyMs: Date.now() - h.turnStartedAt,
          tokensIn: rec.usage?.input_tokens,
          tokensOut: rec.usage?.output_tokens,
          costUsd: rec.total_cost_usd,
        });
        h.turnCallId = null;
      }
      h.busy = false;
      emit({ type: "session.state", sessionId: sid, state: "idle" });
      return;
    }

    default:
      return; // control frames, rate limits, etc.
  }
}
