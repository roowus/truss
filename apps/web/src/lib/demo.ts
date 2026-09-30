/* In-browser simulation of a Truss server. Speaks the exact same contract as the
   live backend so the UI can be exercised without a host. */
import { ApiError, type Backend, type ConnStatus, type TerminalHandlers } from "./backend";
import type {
  Capabilities,
  CreateSessionBody,
  Frame,
  HarnessesResp,
  ModelInfo,
  ProtoEvent,
  SessionMeta,
  SkillInfo,
  TerminalInfo,
} from "./proto";

type Dist<T> = T extends unknown ? Omit<T, "sessionId"> : never;
type EvBody = Dist<ProtoEvent>;

const CAPS: Record<string, Capabilities> = {
  pi: { permissions: false, subagents: false, streaming: true, queueWhileRunning: true },
  dsh: { permissions: true, subagents: false, streaming: true, queueWhileRunning: false },
  "claude-code": { permissions: true, subagents: true, streaming: true, queueWhileRunning: false },
  hermes: { permissions: true, subagents: false, streaming: true, queueWhileRunning: false },
};
const baseOf = (h: string) => h.split("@")[0];

const MODELS: ModelInfo[] = [
  { harness: "pi", provider: "anthropic", model: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
  { harness: "pi", provider: "openai", model: "gpt-5", label: "GPT-5" },
  { harness: "pi", provider: "google", model: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  { harness: "dsh", provider: "deepseek", model: "deepseek-v3.2", label: "DeepSeek V3.2" },
  { harness: "dsh", provider: "deepseek", model: "deepseek-reasoner", label: "DeepSeek Reasoner" },
  { harness: "claude-code", provider: "anthropic", model: "claude-opus-4-1", label: "Claude Opus 4.1" },
  { harness: "claude-code", provider: "anthropic", model: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
  { harness: "hermes", provider: "nous", model: "hermes-4-405b", label: "Hermes 4 405B" },
  { harness: "hermes", provider: "nous", model: "hermes-4-70b", label: "Hermes 4 70B" },
  { harness: "pi@atlas", provider: "ollama", model: "qwen3-coder:30b", label: "Qwen3 Coder 30B (atlas)" },
];

const CTX_TOTAL: Record<string, number> = { pi: 200_000, dsh: 128_000, hermes: 131_072, "claude-code": 200_000 };
const PERM_OPTS: Record<string, string[]> = {
  dsh: ["allow", "allow always", "deny"],
  "claude-code": ["allow", "allow for session", "deny"],
  hermes: ["approve", "deny"],
};
const TOOLS: Record<string, { read: string; grep: string; shell: string; write: string }> = {
  pi: { read: "read", grep: "grep", shell: "bash", write: "write" },
  dsh: { read: "fs.read", grep: "fs.search", shell: "shell.exec", write: "fs.write" },
  "claude-code": { read: "Read", grep: "Grep", shell: "Bash", write: "Write" },
  hermes: { read: "read_file", grep: "search_files", shell: "terminal", write: "write_file" },
};

/* ---------------- virtual filesystem shared by tools and shells ---------------- */
const HOME = "/home/dev";
const fs = new Map<string, string>();
const dirs = new Set<string>(["/", "/home", HOME]);
function mkdirp(p: string) {
  const parts = p.split("/").filter(Boolean);
  let cur = "";
  for (const part of parts) {
    cur += "/" + part;
    dirs.add(cur);
  }
}
function writeFile(p: string, c: string) {
  mkdirp(p.slice(0, p.lastIndexOf("/")) || "/");
  fs.set(p, c);
}
function resolvePath(cwd: string, p: string) {
  if (!p) return cwd;
  let abs = p.startsWith("/") ? p : p.startsWith("~") ? HOME + p.slice(1) : cwd + "/" + p;
  const out: string[] = [];
  for (const seg of abs.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return "/" + out.join("/");
}
function ls(p: string) {
  const pre = p === "/" ? "/" : p + "/";
  const names = new Set<string>();
  for (const d of dirs) if (d.startsWith(pre) && d !== p) names.add(d.slice(pre.length).split("/")[0] + "/");
  for (const f of fs.keys()) if (f.startsWith(pre)) {
    const rest = f.slice(pre.length);
    names.add(rest.includes("/") ? rest.split("/")[0] + "/" : rest);
  }
  return [...names].sort();
}
[
  ["code/truss/README.md", "# Truss\nA universal head for agentic-loop harnesses.\n"],
  ["code/truss/package.json", '{\n  "name": "truss",\n  "private": true,\n  "packageManager": "pnpm@9"\n}\n'],
  ["code/truss/apps/web/src/main.tsx", "// web entry\n"],
  ["code/truss/apps/server/src/index.ts", "// fastify entry\n"],
  ["code/truss/packages/proto/src/index.ts", "export type ProtoEvent = /* … */ never;\n"],
  ["code/ledger/schema.sql", "create table invoices (id integer primary key, total_cents integer);\n"],
  ["code/ledger/migrations/0007_billing.sql", "-- pending\n"],
  ["notes/rfc-0042.md", "# RFC 0042 — Streaming tool output\n"],
].forEach(([p, c]) => writeFile(`${HOME}/${p}`, c));

/* ---------------- helpers ---------------- */
class Aborted extends Error {}
interface TurnCtx {
  aborted: boolean;
  openMsg?: string;
  openCall?: { id: string; start: number };
  openTools: Set<string>;
  pendingPerm?: { requestId: string; resolve: (c: string) => void };
}
interface DemoSession {
  meta: SessionMeta;
  events: Frame[];
  spawn: number;
  n: number;
  turn?: TurnCtx;
  queue: string[];
  ctxUsed: number;
  memory: { codeword?: string; topics: string[] };
  allowAlways: boolean;
}

const chunkers: Record<string, { split: (s: string) => string[]; delay: number }> = {
  pi: { split: (s) => s.match(/\S+\s*|\s+/g) ?? [s], delay: 28 },
  dsh: { split: (s) => s.match(/[^.!?\n]+[.!?\n]*\s*/g) ?? [s], delay: 320 },
  "claude-code": { split: (s) => s.split(/(?<=\n\n)/), delay: 650 },
  hermes: { split: (s) => (s.match(/(?:\S+\s*){1,4}/g) ?? [s]), delay: 70 },
};

function answerFor(text: string, s: DemoSession): { thinking: string; lead: string; answer: string } {
  const t = text.toLowerCase();
  const cw = text.match(/code\s*word\s+(?:is|=|:)\s*["']?([\w-]+)/i);
  if (cw) {
    s.memory.codeword = cw[1];
    return {
      thinking: `The user wants me to remember a codeword. I'll store "${cw[1]}" in working memory and confirm briefly.`,
      lead: "",
      answer: `Got it — I'll remember the codeword **${cw[1]}**. Ask me for it any time, even after a restart.`,
    };
  }
  if (/code\s*word/.test(t)) {
    const c = s.memory.codeword;
    return {
      thinking: c
        ? `Searching earlier turns in this conversation… the user set the codeword to "${c}" before. Resumed history is intact.`
        : "Scanning the conversation for a codeword… none was ever set.",
      lead: "",
      answer: c ? `The codeword is **${c}**.` : "No codeword has been set in this session yet.",
    };
  }
  const topic = text.replace(/\s+/g, " ").slice(0, 60);
  s.memory.topics.push(topic);
  return {
    thinking:
      `Let me break the request down: "${topic}". First I should look at the relevant files in ${s.meta.cwd} ` +
      `to ground the answer, then check for existing conventions before proposing changes. ` +
      `I'll keep tool usage minimal and read-only unless a write is clearly required.`,
    lead: `I'll inspect the workspace first.`,
    answer:
      `Here's what I found for **${topic}**:\n\n` +
      `- The entry point lives in \`apps/server/src/index.ts\`; event fan-out goes through a single bus.\n` +
      `- Sequence numbers are SQLite rowids, so dedupe on \`seq\` is safe across hydration and live frames.\n` +
      `- Nothing in the current layout blocks the change.\n\n` +
      "```ts\nfunction apply(frame: Frame) {\n  if (frame.seq <= lastSeq[frame.ev.sessionId]) return; // dedupe\n  lastSeq[frame.ev.sessionId] = frame.seq;\n  reduce(frame.ev);\n}\n```\n\n" +
      `Want me to go ahead and wire this in, or keep it as a proposal?`,
  };
}

/* ---------------- fake shell ---------------- */
class FakeShell {
  buf = "";
  line = "";
  alive = true;
  history: string[] = [];
  cols = 80;
  rows = 24;
  listeners = new Set<TerminalHandlers>();
  constructor(public info: TerminalInfo & { cwd: string }) {
    this.write(`\x1b[2mtruss demo shell · ${info.cwd}\x1b[0m\r\n\x1b[2mtype \x1b[0mhelp\x1b[2m for commands\x1b[0m\r\n`);
    this.prompt();
  }
  write(s: string) {
    this.buf += s;
    if (this.buf.length > 128 * 1024) this.buf = this.buf.slice(-128 * 1024);
    this.listeners.forEach((l) => l.onOut(s));
  }
  prompt() {
    const short = this.info.cwd.startsWith(HOME) ? "~" + this.info.cwd.slice(HOME.length) : this.info.cwd;
    this.write(`\x1b[38;5;215mdev@truss\x1b[0m:\x1b[38;5;116m${short}\x1b[0m$ `);
  }
  input(data: string) {
    if (!this.alive) return;
    if (data.startsWith("\x1b")) return; // arrows etc.
    for (const ch of data) {
      if (ch === "\r") {
        this.write("\r\n");
        const cmd = this.line.trim();
        this.line = "";
        if (cmd) this.history.push(cmd);
        this.exec(cmd);
        if (this.alive) this.prompt();
      } else if (ch === "\x7f") {
        if (this.line) {
          this.line = this.line.slice(0, -1);
          this.write("\b \b");
        }
      } else if (ch === "\x03") {
        this.line = "";
        this.write("^C\r\n");
        this.prompt();
      } else if (ch === "\x0c") {
        this.write("\x1b[2J\x1b[H");
        this.prompt();
        this.write(this.line);
      } else if (ch >= " ") {
        this.line += ch;
        this.write(ch);
      }
    }
  }
  out(s: string) {
    this.write(s.replace(/\n/g, "\r\n") + (s.endsWith("\n") || !s ? "" : "\r\n"));
  }
  exec(cmdline: string) {
    if (!cmdline) return;
    const redirect = cmdline.match(/^(.*?)\s*>\s*(\S+)$/);
    const [cmd, ...args] = (redirect ? redirect[1] : cmdline).split(/\s+/);
    const cwd = this.info.cwd;
    let output = "";
    switch (cmd) {
      case "help":
        output = "commands: ls, cd, pwd, cat, echo, touch, date, whoami, uname, stty size, history, clear, truss, exit";
        break;
      case "ls": {
        const p = resolvePath(cwd, args.find((a) => !a.startsWith("-")) ?? "");
        if (fs.has(p)) output = p.split("/").pop()!;
        else if (!dirs.has(p)) output = `ls: cannot access '${args[0]}': No such file or directory`;
        else output = ls(p).map((n) => (n.endsWith("/") ? `\x1b[38;5;116m${n}\x1b[0m` : n)).join("  ");
        break;
      }
      case "cd": {
        const p = resolvePath(cwd, args[0] ?? "~");
        if (dirs.has(p)) this.info.cwd = p;
        else output = `cd: ${args[0]}: No such file or directory`;
        break;
      }
      case "pwd": output = cwd; break;
      case "cat": {
        const p = resolvePath(cwd, args[0] ?? "");
        output = fs.has(p) ? fs.get(p)! : `cat: ${args[0]}: No such file or directory`;
        break;
      }
      case "echo": output = args.join(" ").replace(/^["']|["']$/g, ""); break;
      case "touch": writeFile(resolvePath(cwd, args[0] ?? "untitled"), ""); break;
      case "date": output = new Date().toString(); break;
      case "whoami": output = "dev"; break;
      case "uname": output = "Linux truss 6.8.0-truss #1 SMP x86_64 GNU/Linux"; break;
      case "stty": output = `${this.rows} ${this.cols}`; break;
      case "history": output = this.history.map((h, i) => `${String(i + 1).padStart(4)}  ${h}`).join("\n"); break;
      case "clear": this.write("\x1b[2J\x1b[H"); return;
      case "truss":
        output = "\x1b[38;5;215m  /\\/\\/\\/\\/\\\n /_\\/_\\/_\\/_\\\x1b[0m  truss · one head, many harnesses";
        break;
      case "exit":
        this.alive = false;
        this.write("logout\r\n");
        this.listeners.forEach((l) => l.onExit?.(0));
        return;
      default:
        output = `${cmd}: command not found`;
    }
    if (redirect) {
      writeFile(resolvePath(cwd, redirect[2]), output + "\n");
      return;
    }
    if (output) this.out(output);
  }
}

/* ---------------- the demo backend ---------------- */
export function createDemoBackend(): Backend {
  let seq = 0;
  let virtualClock: number | null = null;
  const now = () => virtualClock ?? Date.now();
  const sessions = new Map<string, DemoSession>();
  const listeners = new Set<(f: Frame) => void>();
  const statusListeners = new Set<(s: ConnStatus) => void>();
  const terminals = new Map<string, FakeShell>();
  let busUp = true;
  let termN = 0;

  const emit = (s: DemoSession, body: EvBody) => {
    const f: Frame = { seq: ++seq, ev: { ...body, sessionId: s.meta.id } as ProtoEvent };
    s.events.push(f);
    s.meta.updated_at = now();
    if (body.type === "session.state") s.meta.state = body.state;
    if (busUp && virtualClock === null) listeners.forEach((l) => l(f));
  };

  const sleep = (ms: number, ctx?: TurnCtx) => {
    if (virtualClock !== null) {
      virtualClock += ms;
      return Promise.resolve();
    }
    return new Promise<void>((res, rej) =>
      setTimeout(() => (ctx?.aborted ? rej(new Aborted()) : res()), ms),
    );
  };
  const check = (ctx: TurnCtx) => {
    if (ctx.aborted) throw new Aborted();
  };
  const id = (s: DemoSession, kind: string) => `${s.meta.id}:${s.spawn}:${kind}${++s.n}`;

  async function stream(s: DemoSession, ctx: TurnCtx, messageId: string, text: string, channel?: string) {
    const ch = chunkers[baseOf(s.meta.harness)] ?? chunkers.pi;
    for (const piece of ch.split(text)) {
      await sleep(ch.delay * (0.6 + Math.random() * 0.8), ctx);
      check(ctx);
      emit(s, { type: "msg.chunk", messageId, text: piece, ...(channel ? { channel } : {}) });
    }
  }

  async function llmCall(s: DemoSession, ctx: TurnCtx, outText: string, retryOf?: string) {
    const callId = id(s, "c");
    const start = now();
    ctx.openCall = { id: callId, start };
    emit(s, { type: "llm.call.start", callId, model: s.meta.model ?? "default", at: start });
    return {
      callId,
      done: (status = 200) => {
        const h = baseOf(s.meta.harness);
        const tokensIn = s.ctxUsed + 1800 + Math.round(Math.random() * 900);
        const tokensOut = Math.max(12, Math.round(outText.length / 3.8));
        s.ctxUsed = Math.min(CTX_TOTAL[h] ?? 128000, tokensIn + tokensOut);
        const perCall = h === "pi";
        emit(s, {
          type: "llm.call.done",
          callId,
          status,
          latencyMs: now() - start,
          ...(perCall && status === 200
            ? { tokensIn, tokensOut, costUsd: +(tokensIn * 3e-6 + tokensOut * 15e-6).toFixed(5) }
            : {}),
          ...(retryOf ? { retryOf } : {}),
        });
        ctx.openCall = undefined;
      },
    };
  }

  async function tool(s: DemoSession, ctx: TurnCtx, callId: string, name: string, args: unknown, output: string, risky = false, dur = 600) {
    const toolCallId = id(s, "t");
    const t0 = now();
    ctx.openTools.add(toolCallId);
    emit(s, { type: "tool.call", toolCallId, name, args, callId });
    const h = baseOf(s.meta.harness);
    if (risky && CAPS[h]?.permissions && !s.allowAlways) {
      const requestId = id(s, "p");
      const options = PERM_OPTS[h];
      emit(s, {
        type: "perm.request",
        requestId,
        tool: name,
        reason: `${name} wants to ${typeof args === "object" && args && "path" in args ? `write ${(args as any).path}` : `run: ${JSON.stringify(args)}`}`,
        options,
      });
      let choice: string;
      if (virtualClock !== null) choice = options[0];
      else choice = await new Promise<string>((resolve) => (ctx.pendingPerm = { requestId, resolve }));
      ctx.pendingPerm = undefined;
      emit(s, { type: "perm.resolve", requestId, choice });
      check(ctx);
      if (/always|session/.test(choice)) s.allowAlways = true;
      if (/deny|reject/i.test(choice)) {
        ctx.openTools.delete(toolCallId);
        emit(s, { type: "tool.done", toolCallId, ok: false, durationMs: now() - t0, output: "denied by user" });
        return false;
      }
    }
    const lines = output.split("\n");
    if (lines.length > 2) {
      for (let i = 0; i < lines.length; i += 2) {
        await sleep(dur / Math.ceil(lines.length / 2), ctx);
        emit(s, { type: "tool.update", toolCallId, output: lines.slice(0, i + 2).join("\n") });
      }
    } else await sleep(dur, ctx);
    check(ctx);
    ctx.openTools.delete(toolCallId);
    emit(s, { type: "tool.done", toolCallId, ok: true, durationMs: now() - t0, output });
    return true;
  }

  async function runTurn(s: DemoSession, text: string, userEmitted = false) {
    const ctx: TurnCtx = { aborted: false, openTools: new Set() };
    s.turn = ctx;
    const h = baseOf(s.meta.harness);
    const T = TOOLS[h] ?? TOOLS.pi;
    try {
      if (!userEmitted) emitUser(s, text);
      emit(s, { type: "session.state", state: "running" });
      const plan = answerFor(text, s);
      const lower = text.toLowerCase();
      const risky = /\b(write|create|save|delete|rm|install|fix|edit|touch|run|exec|file)\b/.test(lower);
      const simple = !plan.lead;

      // call 1 — reasoning (+ optional failing call and retry)
      let retryOf: string | undefined;
      if (!simple && (lower.includes("retry") || (h === "pi" && Math.random() < 0.25))) {
        const bad = await llmCall(s, ctx, "");
        await sleep(900, ctx);
        bad.done(529);
        retryOf = bad.callId;
        await sleep(400, ctx);
      }
      const c1 = await llmCall(s, ctx, plan.thinking + plan.lead, retryOf);
      const m1 = id(s, "m");
      ctx.openMsg = m1;
      emit(s, { type: "msg.start", messageId: m1, role: "assistant", at: now() });
      await stream(s, ctx, m1, plan.thinking, "thinking");
      if (simple) {
        await stream(s, ctx, m1, plan.answer);
        emit(s, { type: "msg.done", messageId: m1, stopReason: "end_turn" });
        ctx.openMsg = undefined;
        c1.done();
      } else {
        await stream(s, ctx, m1, plan.lead);
        emit(s, { type: "msg.done", messageId: m1, stopReason: "tool_use" });
        ctx.openMsg = undefined;
        await tool(s, ctx, c1.callId, T.grep, { pattern: "seq", path: "apps/server/src" },
          "apps/server/src/bus.ts:14:  const seq = row.id;\napps/server/src/bus.ts:22:  emit({ seq, ev });\napps/server/src/store.ts:41:  lastInsertRowid as seq", false, 500);
        await tool(s, ctx, c1.callId, T.read, { path: "apps/server/src/index.ts" },
          "import Fastify from 'fastify';\nimport { bus } from './bus';\nconst app = Fastify();\napp.register(ws);\napp.listen({ port: 4040 });", false, 400);
        if (risky) {
          const p = `${s.meta.cwd}/truss-check.txt`;
          const ok = await tool(s, ctx, c1.callId, T.write, { path: "truss-check.txt", content: "written by " + s.meta.harness }, `wrote ${p} (1 line)`, true, 300);
          if (ok) writeFile(p, `written by ${s.meta.harness} at ${new Date(now()).toISOString()}\n`);
          await tool(s, ctx, c1.callId, T.shell, { command: "ls -1 truss-check.txt" }, ok ? "truss-check.txt" : "ls: cannot access 'truss-check.txt'", false, 300);
        }
        c1.done();

        if (h === "claude-code" && /\b(team|parallel|audit|review|explore|agents?)\b/.test(lower)) {
          const a1 = id(s, "a"), a2 = id(s, "a"), a3 = id(s, "a");
          const cT = await llmCall(s, ctx, "delegating");
          await tool(s, ctx, cT.callId, "Task", { description: "Explore routes", subagent_type: "Explore" }, "spawned", false, 200);
          emit(s, { type: "subagent.spawn", agentId: a1, label: "Explore · HTTP routes" });
          emit(s, { type: "subagent.spawn", agentId: a2, label: "Explore · session store" });
          await sleep(700, ctx);
          emit(s, { type: "subagent.spawn", agentId: a3, label: "grep · token usage", parentAgentId: a1 });
          await sleep(1400, ctx);
          emit(s, { type: "subagent.done", agentId: a3, ok: true });
          await sleep(600, ctx);
          emit(s, { type: "subagent.done", agentId: a1, ok: true });
          await sleep(500, ctx);
          emit(s, { type: "subagent.done", agentId: a2, ok: Math.random() > 0.3 });
          cT.done();
        }

        const c2 = await llmCall(s, ctx, plan.answer);
        const m2 = id(s, "m");
        ctx.openMsg = m2;
        emit(s, { type: "msg.start", messageId: m2, role: "assistant", at: now() });
        await stream(s, ctx, m2, "Tool results look consistent; composing the answer.", "thinking");
        await stream(s, ctx, m2, plan.answer);
        emit(s, { type: "msg.done", messageId: m2, stopReason: "end_turn" });
        ctx.openMsg = undefined;
        c2.done();
      }
      if (h !== "claude-code") emit(s, { type: "ctx.usage", used: s.ctxUsed, total: CTX_TOTAL[h] ?? 128000 });
      emit(s, { type: "session.state", state: "idle" });
    } catch (e) {
      if (!(e instanceof Aborted)) throw e;
      if (s.turn !== ctx) return; // process died (restart) — no events
      if (ctx.pendingPerm) emit(s, { type: "perm.resolve", requestId: ctx.pendingPerm.requestId, choice: "cancelled" });
      for (const t of ctx.openTools) emit(s, { type: "tool.done", toolCallId: t, ok: false, output: "interrupted" });
      if (ctx.openMsg) emit(s, { type: "msg.done", messageId: ctx.openMsg, stopReason: "interrupted" });
      if (ctx.openCall) emit(s, { type: "llm.call.done", callId: ctx.openCall.id, status: 499, latencyMs: now() - ctx.openCall.start });
      emit(s, { type: "session.state", state: "idle", detail: "interrupted" });
    } finally {
      if (s.turn === ctx) s.turn = undefined;
    }
    const next = s.queue.shift();
    if (next !== undefined && s.meta.live) void runTurn(s, next, true);
  }

  function emitUser(s: DemoSession, text: string) {
    const mid = id(s, "u");
    emit(s, { type: "msg.start", messageId: mid, role: "user", at: now() });
    emit(s, { type: "msg.chunk", messageId: mid, text });
    emit(s, { type: "msg.done", messageId: mid });
    if (s.meta.title === "new session") s.meta.title = text.replace(/\s+/g, " ").slice(0, 42);
  }

  function make(body: CreateSessionBody, state: SessionMeta["state"] = "spawning", fixedId?: string): DemoSession {
    const sid = fixedId ?? "s_" + Math.random().toString(36).slice(2, 8);
    const s: DemoSession = {
      meta: {
        id: sid,
        harness: body.harness,
        title: body.title || "new session",
        cwd: body.cwd,
        model: body.model,
        project: body.project || undefined,
        state,
        created_at: now(),
        updated_at: now(),
        live: true,
      },
      events: [],
      spawn: 1,
      n: 0,
      queue: [],
      ctxUsed: 3000,
      memory: { topics: [] },
      allowAlways: false,
    };
    sessions.set(sid, s);
    emit(s, { type: "session.created", harness: body.harness, title: s.meta.title, cwd: body.cwd, model: body.model, project: body.project, at: now() });
    return s;
  }

  async function boot(s: DemoSession, resume: boolean) {
    emit(s, { type: "session.state", state: "spawning", detail: resume ? "resuming harness" : "booting harness" });
    s.meta.live = true;
    const h = baseOf(s.meta.harness);
    await sleep(h === "dsh" ? (resume ? 3500 : 6500) : 1200 + Math.random() * 600);
    emit(s, { type: "session.state", state: "idle" });
  }

  const ready = (async () => {
    virtualClock = Date.now() - 1000 * 60 * 60 * 5;
    const seedTurn = async (s: DemoSession, text: string) => {
      await runTurn(s, text);
      virtualClock! += 1000 * 60 * (4 + Math.random() * 20);
    };
    const a = make({ harness: "pi", cwd: `${HOME}/code/truss`, model: "claude-sonnet-4-5", project: "truss" }, "idle", "demo-pi");
    await seedTurn(a, "How does seq dedupe work between hydration and the live bus?");
    await seedTurn(a, "The codeword is marmalade");
    const b = make({ harness: "claude-code", cwd: `${HOME}/code/truss`, model: "claude-opus-4-1", project: "truss" }, "idle", "demo-claude");
    await seedTurn(b, "Audit the auth middleware with a team of agents");
    const c = make({ harness: "dsh", cwd: `${HOME}/code/ledger`, model: "deepseek-v3.2", project: "ledger" }, "idle", "demo-dsh");
    await seedTurn(c, "Plan the billing schema migration and write a check file");
    c.meta.state = "closed";
    c.meta.live = false;
    const d = make({ harness: "hermes", cwd: `${HOME}/notes`, model: "hermes-4-405b" }, "idle", "demo-hermes");
    await seedTurn(d, "Summarize RFC 0042 in three bullets");
    virtualClock = null;
    for (const s of sessions.values()) s.meta.updated_at = Date.now() - Math.random() * 1000 * 60 * 90;
    const t = new FakeShell({ id: "t_" + ++termN, title: "shell", cwd: `${HOME}/code/truss` });
    terminals.set(t.info.id, t);
  })();

  const get = (sid: string) => {
    const s = sessions.get(sid);
    if (!s) throw new ApiError(404, `session ${sid} not found`);
    return s;
  };
  const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
  const net = (ms = 60) => new Promise((r) => setTimeout(r, ms + Math.random() * 60));

  return {
    mode: "demo",
    async harnesses(): Promise<HarnessesResp> {
      await net();
      const hs = Object.entries(CAPS).map(([id, capabilities]) => ({ id, capabilities }));
      hs.push({ id: "pi@atlas", capabilities: CAPS.pi });
      return { harnesses: hs, models: MODELS };
    },
    async agents() {
      await net();
      return { agents: [{ hostId: "atlas", hostname: "atlas", adapters: ["pi"] }] };
    },
    async listSessions() {
      await ready;
      await net();
      const list = [...sessions.values()].map((s) => clone(s.meta));
      list.sort((x, y) => +y.updated_at - +x.updated_at);
      return { sessions: list };
    },
    async createSession(body) {
      await ready;
      await net(120);
      if (!body.harness) throw new ApiError(400, "harness is required");
      if (!body.cwd?.startsWith("/")) throw new ApiError(400, "cwd must be an absolute path");
      if (!CAPS[baseOf(body.harness)]) throw new ApiError(400, `unknown harness ${body.harness}`);
      mkdirp(body.cwd);
      const s = make(body);
      void boot(s, false);
      return { session: clone(s.meta) };
    },
    async getSession(sid) {
      await ready;
      return { session: clone(get(sid).meta) };
    },
    async getEvents(sid) {
      await ready;
      await net(90);
      return { events: clone(get(sid).events) };
    },
    async prompt(sid, text) {
      await ready;
      await net();
      const s = get(sid);
      const caps = CAPS[baseOf(s.meta.harness)];
      if (s.meta.state === "closed" || s.meta.state === "error") {
        s.spawn++;
        void (async () => {
          emitUser(s, text);
          await boot(s, true);
          await runTurn(s, text, true);
        })();
        return { ok: true };
      }
      if (s.meta.state === "spawning") throw new ApiError(409, "harness is still booting — try again in a moment");
      if (s.turn) {
        if (!caps.queueWhileRunning) throw new ApiError(409, `${s.meta.harness} does not accept input while a turn is running`);
        emitUser(s, text);
        s.queue.push(text);
        return { ok: true };
      }
      void runTurn(s, text);
      return { ok: true };
    },
    async interrupt(sid) {
      await net(30);
      const s = get(sid);
      if (s.turn) {
        s.turn.aborted = true;
        s.queue = [];
        s.turn.pendingPerm?.resolve("cancelled");
      }
      return { ok: true };
    },
    async permission(sid, requestId, choice) {
      await net(40);
      const s = get(sid);
      const p = s.turn?.pendingPerm;
      if (!p || p.requestId !== requestId) throw new ApiError(404, `no pending permission ${requestId}`);
      const opts = PERM_OPTS[baseOf(s.meta.harness)];
      if (!opts.includes(choice)) throw new ApiError(400, `choice must be one of ${opts.join(", ")}`);
      p.resolve(choice);
      return { ok: true };
    },
    async deleteSession(sid, hard) {
      await net();
      const s = get(sid);
      if (s.turn) {
        const t = s.turn;
        s.turn = undefined;
        t.aborted = true;
      }
      if (hard) sessions.delete(sid);
      else {
        s.meta.live = false;
        emit(s, { type: "session.state", state: "closed", detail: "closed by user" });
      }
      return { ok: true };
    },
    async listTerminals() {
      await ready;
      return { terminals: [...terminals.values()].map((t) => ({ ...t.info, alive: t.alive })) };
    },
    async createTerminal(body) {
      await net();
      const cwd = body.cwd && dirs.has(body.cwd) ? body.cwd : HOME;
      const t = new FakeShell({ id: "t_" + ++termN, title: body.title || "shell", cwd });
      terminals.set(t.info.id, t);
      return { terminal: { ...t.info, alive: true } };
    },
    async deleteTerminal(tid) {
      await net(20);
      terminals.delete(tid);
      return { ok: true };
    },
    async skills(cwd): Promise<{ skills: SkillInfo[] }> {
      await net(150);
      const base: SkillInfo[] = [
        { name: "pdf", description: "Extract text and tables from PDF files, fill forms, merge documents.", source: "~/.agents/skills/pdf", scope: "user" },
        { name: "webapp-testing", description: "Drive a local web app with Playwright to verify UI behavior.", source: "~/.agents/skills/webapp-testing", scope: "user" },
        { name: "changelog", description: "Draft release notes from merged PRs since the last tag.", source: "~/.agents/skills/changelog", scope: "user" },
      ];
      if (cwd.includes("truss"))
        base.unshift(
          { name: "truss-deploy", description: "Build apps/web and restart the systemd unit on the host.", source: `${cwd}/.agents/skills/truss-deploy`, scope: "project" },
          { name: "proto-change", description: "Checklist for evolving packages/proto without breaking adapters.", source: `${cwd}/.agents/skills/proto-change`, scope: "project" },
        );
      if (cwd.includes("ledger"))
        base.unshift({ name: "sql-migrate", description: "Write reversible SQL migrations with a dry-run step.", source: `${cwd}/.agents/skills/sql-migrate`, scope: "project" });
      return { skills: base };
    },
    /* Files panel demo: a tiny static tree, enough to click around */
    async listFiles(_root, path, q) {
      await net(60);
      const all = [
        { name: "src", path: "src", kind: "dir" as const, size: 0, mtime: Date.now() - 86400_000 },
        { name: "README.md", path: "README.md", kind: "file" as const, size: 1902, mtime: Date.now() - 3600_000 },
        { name: "package.json", path: "package.json", kind: "file" as const, size: 640, mtime: Date.now() - 7200_000 },
        { name: "main.ts", path: "src/main.ts", kind: "file" as const, size: 412, mtime: Date.now() - 1800_000 },
        { name: "util.ts", path: "src/util.ts", kind: "file" as const, size: 208, mtime: Date.now() - 900_000 },
      ];
      if (q) return { entries: all.filter((e) => e.name.toLowerCase().includes(q.toLowerCase())) };
      const prefix = path && path !== "." ? `${path}/` : "";
      return { entries: all.filter((e) => e.path.startsWith(prefix) && !e.path.slice(prefix.length).includes("/")) };
    },
    async readFile(_root, path) {
      await net(60);
      const name = path.split("/").pop() ?? path;
      return { name, path, size: 64, mtime: Date.now(), kind: "text" as const, text: `// demo preview of ${name}\n// the live server reads the real file.\n` };
    },
    writeFile: async (_root, path) => ({ name: path.split("/").pop() ?? path, path, size: 0, mtime: Date.now(), kind: "text" as const, text: "" }),
    createFile: async (_root, path, kind) => ({ name: path.split("/").pop() ?? path, path, kind, size: 0, mtime: Date.now() }),
    toggleSkill: async () => ({ ok: true }),
    createSkill: async () => ({ ok: true }),
    deleteSkill: async () => ({ ok: true }),
    gitStatus: async () => ({ isRepo: true, branch: "main", ahead: 1, changes: [{ path: "src/main.ts", x: "M", y: " " }] }),
    gitBranches: async () => ({ branches: [{ name: "main", current: true, last: "demo commit", at: Date.now() - 3600_000 }] }),
    gitGraph: async () => ({ graph: "* a1b2c3d (HEAD -> main) demo commit\n* e4f5g6h earlier work\n" }),
    gitDiff: async (_cwd, path) => ({ diff: `--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,2 @@\n // demo\n+// changed\n` }),
    gitSwitch: async (_cwd, branch) => ({ branch }),
    hosts: async () => ({ hosts: [{ id: "atlas", label: "atlas", tokenPrefix: "…demo01", createdAt: Date.now() - 86400_000 * 9, lastSeen: Date.now() - 3600_000, revoked: false, note: "the other box", online: true, agent: { hostId: "atlas", hostname: "atlas", adapters: ["pi"] } }] }),
    createHost: async (label: string) => ({ host: { id: "new-host", label, tokenPrefix: "…demo02", createdAt: Date.now(), revoked: false, note: "", online: false } as never, token: "truss_agent_demo" }),
    setSessionModel: async () => ({ mode: "stored" as const }),
    trash: async () => ({ sessions: [] }),
    upload: async (_id, name) => ({ upload: { name, path: `.truss-uploads/${name}`, size: 1234 } }),
    bulkDeleteSessions: async (ids) => ({ deleted: ids.length }),
    restoreSession: async () => ({ ok: true }),
    purgeSession: async () => ({ ok: true }),
    rotateHostToken: async () => ({ token: "truss_agent_demo_rotated" }),
    revokeHost: async () => ({ ok: true }),
    deleteHost: async () => ({ ok: true }),
    pairHost: async (_id, _t, serverUrl) => ({ code: "k3xm7q", expiresAt: Date.now() + 600_000, url: `${serverUrl}/i/k3xm7q`, command: `curl -fsSL ${serverUrl}/i/k3xm7q | sh` }),
    taildropHost: async () => ({ ok: true, file: "truss-install-demo.sh" }),
    metrics: async () => {
      const t = Date.now();
      const mk = (host: string, cpuBase: number): never => {
        const cores = 4;
        const perCore = Array.from({ length: cores }, () => Math.round((cpuBase + Math.random() * 18) * 10) / 10);
        const total = 16e9, used = 6.4e9 + Math.random() * 3e8;
        const history = Array.from({ length: 120 }, (_, i) => ({ t: t - (120 - i) * 5000, cpu: cpuBase + Math.sin(i / 9) * 14 + Math.random() * 6, mem: 38 + Math.cos(i / 14) * 5, rx: 200e3 + Math.random() * 900e3, tx: 120e3 + Math.random() * 700e3 }));
        return {
          hostname: host,
          metrics: {
            at: t,
            host: { hostname: host, os: "Ubuntu 24.04 LTS", kernel: "6.17.0", arch: "aarch64", cpuModel: "ARM Neoverse-N1", cores },
            uptimeSec: 367000,
            cpu: { usage: perCore.reduce((a, b) => a + b, 0) / cores, perCore, load: [0.4, 0.35, 0.2], procs: 194, threads: 465, running: 1, blocked: 0 },
            pressure: { cpu: 0.9, io: 0, mem: 0 },
            mem: { total, used, available: total - used, cached: 4.2e9, swapTotal: 4e9, swapUsed: 0 },
            disks: [{ device: "/dev/sda1", mount: "/", fs: "ext4", total: 200e9, used: 42e9, pct: 21 }],
            net: [{ iface: "enp0s6", rxBps: 320e3, txBps: 210e3 }],
            temps: [{ label: "cpu", c: 47.5 }],
            procs: [
              { pid: 1051, cmd: "node", cpu: 8.4, rssMb: 721, state: "S" },
              { pid: 402, cmd: "postgres", cpu: 2.1, rssMb: 318, state: "S" },
              { pid: 88, cmd: "systemd", cpu: 0.1, rssMb: 44, state: "S" },
            ],
          },
          history,
        } as never;
      };
      return { local: mk("devbox", 9), agents: { atlas: mk("atlas", 34) } };
    },
    netInfo: async () => ({ port: 4040, tailscale: { installed: true, ip4: "100.64.0.1", dnsName: "devbox.example.ts.net", serveOn: false }, lan: ["192.168.1.20"] }),
    tailscalePeers: async () => ({
      self: { hostName: "devbox", dnsName: "devbox.example.ts.net", ip4: "100.64.0.1", os: "linux", online: true, exitNode: false, exitNodeOption: false, tagged: false },
      peers: [
        { hostName: "atlas", dnsName: "atlas.example.ts.net", ip4: "100.64.0.2", os: "linux", online: true, lastSeen: new Date().toISOString(), exitNode: false, exitNodeOption: true, tagged: false },
        { hostName: "macbook-pro", dnsName: "macbook-pro.example.ts.net", ip4: "100.64.0.3", os: "macOS", online: true, lastSeen: new Date().toISOString(), exitNode: false, exitNodeOption: false, tagged: false },
        { hostName: "pixel", dnsName: "pixel.example.ts.net", ip4: "100.64.0.4", os: "android", online: false, lastSeen: new Date(Date.now() - 86400e3 * 12).toISOString(), exitNode: false, exitNodeOption: false, tagged: false },
      ],
    }),
    tailscaleServe: async () => ({ tailscale: { installed: true, ip4: "100.64.0.1", dnsName: "devbox.example.ts.net", serveOn: true, serveUrl: "https://devbox.example.ts.net" } }),
    tasks: async () => ({ tasks: [] }),
    createTask: async (b) => ({ task: { id: "demo-task", status: "todo" as const, createdAt: Date.now(), updatedAt: Date.now(), ...b } }),
    updateTask: async () => ({ ok: true }),
    deleteTask: async () => ({ ok: true }),
    runTask: async () => { throw new Error("Demo mode can't run tasks — start the Truss server."); },
    todos: async () => ({ todos: [] }),
    createTodo: async (b: any) => ({ todo: { id: "demo-todo", notes: "", labels: [], subtasks: [], meta: {}, status: "open" as const, priority: "normal" as const, createdBy: "user" as const, sharedEditors: [], deniedEditors: [], createdAt: Date.now(), updatedAt: Date.now(), ...b } as never }),
    updateTodo: async (_id: string, patch: any) => ({ todo: patch as never }),
    resolveTodoAccess: async () => ({ todo: {} as never }),
    feed: async () => ({ items: [] }),
    setFeedState: async (_id: string, state: string) => ({ item: { state } as never }),
    shareFeed: async (_id: string) => ({ item: {} as never }),
    practices: async () => ({ text: "# Truss practices\n", path: "~/.truss/TRUSS.md" }),
    savePractices: async () => ({ ok: true }),
    composePractices: async () => ({ layers: [], composed: "" }),
    async getLayout() {
      await net(40);
      return { layout: localStorage.getItem("truss.demo.layout") };
    },
    archiveSession: async (id, archived) => {
      const sess = sessions.get(id);
      if (sess) (sess.meta as any).archived = archived ? 1 : 0;
      return { ok: true };
    },
    archiveProject: async (project, archived) => {
      let n = 0;
      for (const sess of sessions.values()) {
        if ((sess.meta as any).project === project) { (sess.meta as any).archived = archived ? 1 : 0; n++; }
      }
      return { ok: true, sessions: n };
    },
    credentials: async () => ({ routes: [], service: "demo", serviceActive: false }),
    upsertCredential: async () => ({ ok: true, restarted: false }),
    deleteCredential: async () => ({ ok: true, restarted: false }),
    credentialsService: async () => ({ ok: true }),
    router: async () => ({ service: "demo", active: false, port: 0, models: [], providers: [], harnesses: [] }),
    routerService: async () => ({ ok: true }),
    costs: async () => ({ sessions: [], totals: { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, hasCost: false } }),
    costsDaily: async () => ({ days: [] }),
    async putLayout(layout) {
      localStorage.setItem("truss.demo.layout", layout);
      return { ok: true };
    },
    connectEvents(onFrame, onStatus) {
      listeners.add(onFrame);
      statusListeners.add(onStatus);
      onStatus({ kind: "connecting", attempt: 0 });
      const t = setTimeout(() => onStatus({ kind: "open", since: Date.now() }), 250);
      return () => {
        clearTimeout(t);
        listeners.delete(onFrame);
        statusListeners.delete(onStatus);
      };
    },
    connectTerminal(tid, h) {
      const t = terminals.get(tid);
      let closed = false;
      setTimeout(() => {
        if (closed) return;
        if (!t) {
          h.onHello?.({ alive: false });
          h.onExit?.(-1);
          return;
        }
        h.onHello?.({ title: t.info.title, alive: t.alive });
        if (t.buf) h.onOut(t.buf);
        t.listeners.add(h);
        if (!t.alive) h.onExit?.(0);
      }, 80);
      return {
        send: (d) => t?.input(d),
        resize: (c, r) => {
          if (t) {
            t.cols = c;
            t.rows = r;
          }
        },
        close: () => {
          closed = true;
          t?.listeners.delete(h);
        },
      };
    },
    simulateRestart() {
      busUp = false;
      for (const s of sessions.values()) {
        if (s.turn) {
          const t = s.turn;
          s.turn = undefined;
          t.aborted = true;
          t.pendingPerm?.resolve("cancelled");
        }
        s.queue = [];
        if (s.meta.live) {
          s.meta.live = false;
          s.meta.state = "closed";
          s.allowAlways = false;
        }
      }
      const retryAt = Date.now() + 2500;
      statusListeners.forEach((l) => l({ kind: "closed", retryAt, attempt: 1 }));
      setTimeout(() => {
        busUp = true;
        statusListeners.forEach((l) => l({ kind: "open", since: Date.now() }));
      }, 2500);
    },
  };
}
