import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { ProtoEvent } from "@truss/proto";
import type { AdapterHandle } from "../src/adapters/types.js";

/*
 * pi adapter end-to-end test against a FAKE `pi` binary.
 *
 * The fake is a node script written into a temp bin dir that is prepended to
 * PATH (the real pi lives at /usr/bin/pi — shadowing is asserted by the fake
 * logging its argv to FAKE_PI_LOG; the real binary would never write there).
 * It speaks strict LF-delimited JSON per vendor/pi-mono docs rpc.md / json.md
 * and produces canned event sequences:
 *   - normal prompt: agent_start → turn_start → message_start(user echo) →
 *     message_start(assistant) → thinking_delta → text_delta "Hello" " world"
 *     (with usage) → message_end(stop) → turn_end → agent_end → agent_settled
 *   - "BOOM" prompt: provider failure surfaces ONLY via message_end with
 *     stopReason "error" + errorMessage (the 400 Unknown Model regression)
 *   - "SLOW" prompt: ~2s of streaming so follow_up / abort can land mid-run
 *   - follow_up while running: queued, gets its own full sequence afterwards
 *   - abort: message_end(stopReason "aborted") → agent_end → agent_settled
 * Every received command is appended to FAKE_PI_LOG as a JSON line so tests
 * can assert what the adapter actually SENT (prompt vs follow_up, argv).
 */

/* env must be set before the adapter module is imported (static imports
   hoist, hence the dynamic import below) */
const ROOT = mkdtempSync(join(tmpdir(), "truss-pi-adapter-"));
const FAKE_HOME = join(ROOT, "home");
mkdirSync(FAKE_HOME, { recursive: true });
const OLD_HOME = process.env.HOME;
const OLD_DATA = process.env.TRUSS_DATA_DIR;
process.env.HOME = FAKE_HOME; // os.homedir() honors $HOME on POSIX
process.env.TRUSS_DATA_DIR = join(ROOT, "data");

const { piAdapter } = await import("../src/adapters/pi.js");

/* ── the fake pi binary ── */

const FAKE_PI_SOURCE = `#!/usr/bin/env node
"use strict";
/* fake pi --mode rpc for truss adapter tests — see pi-adapter.test.ts */
const fs = require("fs");
const logPath = process.env.FAKE_PI_LOG;
const log = (rec) => { if (logPath) fs.appendFileSync(logPath, JSON.stringify(rec) + "\\n"); };
log({ argv: process.argv.slice(2) });
const out = (rec) => process.stdout.write(JSON.stringify(rec) + "\\n");
const USAGE = { input: 11, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.0001 } };
const ERROR_MESSAGE = '400: {"code":"1211","message":"Unknown Model, please check the model code."}';

let running = false;
let timers = [];
const followUps = [];
const later = (ms, fn) => { timers.push(setTimeout(fn, ms)); };
const cancelTimers = () => { for (const t of timers) clearTimeout(t); timers = []; };

function asst(stopReason, errorMessage) {
  const m = { role: "assistant", content: [], stopReason: stopReason, timestamp: Date.now() };
  if (errorMessage) m.errorMessage = errorMessage;
  return m;
}

function drain() {
  if (running) return;
  const next = followUps.shift();
  if (next != null) run(next);
}

function finishRun(stopReason, errorMessage) {
  cancelTimers();
  out({ type: "message_end", message: asst(stopReason, errorMessage) });
  /* real pi skips turn_end on abort */
  if (stopReason !== "aborted") out({ type: "turn_end", message: asst(stopReason, errorMessage), toolResults: [] });
  out({ type: "agent_end", messages: [], willRetry: false });
  out({ type: "agent_settled" });
  running = false;
  setImmediate(drain);
}

function runBoom() {
  /* provider failure (400 Unknown Model): per json.md the provider-level
     error is translated into message_start/message_end — no message_update,
     no deltas. The ONLY signal is message_end stopReason/errorMessage. */
  running = true;
  out({ type: "agent_start" });
  later(20, () => {
    out({ type: "turn_start" });
    out({ type: "message_start", message: asst("pending") });
  });
  later(70, () => finishRun("error", ERROR_MESSAGE));
}

function run(text) {
  if (text.indexOf("BOOM") !== -1) return runBoom();
  const slow = text.indexOf("SLOW") !== -1;
  running = true;
  out({ type: "agent_start" });
  later(15, () => {
    out({ type: "turn_start" });
    out({ type: "message_start", message: { role: "user", content: text, timestamp: Date.now() } });
    out({ type: "message_end", message: { role: "user", content: text, timestamp: Date.now() } });
    out({ type: "message_start", message: asst("pending") });
    if (!slow) out({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hmm" } });
  });
  const chunks = slow ? ["Working", " slowly", " on", " it"] : ["Hello", " world"];
  const step = slow ? 450 : 40;
  chunks.forEach((c, i) => {
    later(40 + i * step, () => {
      out({ type: "message_update", usage: USAGE, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: c } });
    });
  });
  later(60 + chunks.length * step, () => finishRun("stop"));
}

function handle(cmd) {
  const id = cmd.id;
  const GET_STATE_DELAY = Number(process.env.FAKE_PI_GET_STATE_DELAY || 0);
  switch (cmd.type) {
    case "get_state":
      if (GET_STATE_DELAY > 0) {
        /* answer late so the adapter's deferred effort write can race it */
        setTimeout(() => out({ type: "response", id: id, command: "get_state", success: true, data: { sessionId: "fake-pi-session-1", isStreaming: running } }), GET_STATE_DELAY);
        break;
      }
      out({ type: "response", id: id, command: "get_state", success: true, data: { sessionId: "fake-pi-session-1", isStreaming: running } });
      break;
    case "prompt":
      if (running) {
        out({ type: "response", id: id, command: "prompt", success: false, error: "agent is streaming; pass streamingBehavior" });
        break;
      }
      out({ type: "response", id: id, command: "prompt", success: true });
      run(String(cmd.message || ""));
      break;
    case "follow_up":
      out({ type: "response", id: id, command: "follow_up", success: true });
      followUps.push(String(cmd.message || ""));
      setImmediate(drain);
      break;
    case "set_model":
      if (String(cmd.modelId || "").indexOf("NOPE") !== -1) {
        out({ type: "response", id: id, command: "set_model", success: false, error: "Model not found: " + cmd.provider + "/" + cmd.modelId });
        break;
      }
      out({ type: "response", id: id, command: "set_model", success: true, data: { model: { provider: cmd.provider, id: cmd.modelId } } });
      break;
    case "clear_queue":
      followUps.length = 0;
      out({ type: "response", id: id, command: "clear_queue", success: true, data: { steering: [], followUp: [] } });
      break;
    case "abort":
      if (running) finishRun("aborted");
      out({ type: "response", id: id, command: "abort", success: true });
      break;
    default:
      out({ type: "response", id: id, command: cmd.type, success: true });
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    let line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.endsWith("\\r")) line = line.slice(0, -1);
    if (!line.trim()) continue;
    let cmd;
    try { cmd = JSON.parse(line); } catch { out({ type: "response", command: "parse", success: false, error: "bad json" }); continue; }
    log({ cmd: cmd });
    handle(cmd);
  }
});
process.stdin.on("end", () => { if (!process.env.FAKE_PI_IGNORE_END) process.exit(0); });
`;

/* ── harness helpers ── */

interface FakePi {
  dir: string;
  logPath: string;
}

function makeFakePi(tag: string): FakePi {
  const dir = mkdtempSync(join(tmpdir(), `truss-fake-pi-${tag}-`));
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const script = join(binDir, "pi");
  writeFileSync(script, FAKE_PI_SOURCE, { mode: 0o755 });
  chmodSync(script, 0o755);
  return { dir, logPath: join(dir, "pi.log") };
}

/** run fn with the fake pi first on PATH and FAKE_PI_LOG pointed at its log.
    `env` rides along for the whole run (restored afterwards). */
async function withFakePi(
  tag: string,
  fn: (fake: FakePi) => Promise<void>,
  env: Record<string, string> = {},
): Promise<void> {
  const fake = makeFakePi(tag);
  const oldPath = process.env.PATH;
  const oldLog = process.env.FAKE_PI_LOG;
  const oldEnv: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    oldEnv[k] = process.env[k];
    process.env[k] = v;
  }
  process.env.PATH = fake.dir + "/bin:" + (oldPath ?? "");
  process.env.FAKE_PI_LOG = fake.logPath;
  try {
    await fn(fake);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldLog === undefined) delete process.env.FAKE_PI_LOG;
    else process.env.FAKE_PI_LOG = oldLog;
    for (const [k, v] of Object.entries(oldEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(fake.dir, { recursive: true, force: true });
  }
}

async function waitFor(pred: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timeout waiting for: ${what}`);
}

function collect(handle: AdapterHandle): { events: ProtoEvent[]; finished: Promise<void> } {
  const events: ProtoEvent[] = [];
  const finished = (async () => {
    for await (const ev of piAdapter.events(handle)) events.push(ev);
  })();
  return { events, finished };
}

type LogEntry = { argv?: string[]; cmd?: { type?: string; id?: string; message?: string } };

function readLog(logPath: string): LogEntry[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LogEntry);
}

function logCmds(logPath: string): { type?: string; message?: string }[] {
  return readLog(logPath)
    .filter((r) => r.cmd)
    .map((r) => r.cmd!);
}

function logArgv(logPath: string): string[] {
  const rec = readLog(logPath).find((r) => r.argv);
  return rec?.argv ?? [];
}

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function procOf(handle: AdapterHandle): ChildProcess {
  return (handle as unknown as { proc: ChildProcess }).proc;
}

async function shutdown(handle: AdapterHandle, finished: Promise<void>): Promise<void> {
  piAdapter.dispose(handle);
  await Promise.race([finished, new Promise((r) => setTimeout(r, 3000))]);
}

const statesOf = (events: ProtoEvent[]) =>
  events.filter((e) => e.type === "session.state").map((e) => (e as { state: string }).state);

const assistantStarts = (events: ProtoEvent[]) =>
  events.filter((e) => e.type === "msg.start" && (e as { role?: string }).role === "assistant");

/* ── tests ── */

test("spawn: argv carries --mode rpc/--provider/--model, get_state handshake sets harnessRef", { timeout: 15000 }, async () => {
  await withFakePi("spawn", async (fake) => {
    const handle = await piAdapter.spawn({ sessionId: "t-spawn", cwd: tmpdir(), provider: "truss-fw", model: "m" });
    const { events, finished } = collect(handle);
    try {
      await waitFor(() => handle.harnessRef === "fake-pi-session-1", "harnessRef from get_state");
      const argv = logArgv(fake.logPath);
      assert.ok(argv.length > 0, "fake pi logged its argv (proves our binary shadowed /usr/bin/pi)");
      assert.equal(flagValue(argv, "--mode"), "rpc");
      assert.equal(flagValue(argv, "--provider"), "truss-fw");
      assert.equal(flagValue(argv, "--model"), "m");
      assert.equal(flagValue(argv, "--session-dir"), join(process.env.TRUSS_DATA_DIR!, "pi-sessions"));
      // handshake: get_state was the first command the adapter sent
      assert.equal(logCmds(fake.logPath)[0]?.type, "get_state");
      // adapter emits an initial idle state at spawn
      assert.deepEqual(statesOf(events), ["idle"]);
    } finally {
      await shutdown(handle, finished);
    }
  });
});

test("happy path: full run yields state transitions, text+thinking chunks, usage, ctx.usage", { timeout: 15000 }, async () => {
  await withFakePi("happy", async (fake) => {
    const handle = await piAdapter.spawn({ sessionId: "t-happy", cwd: tmpdir(), provider: "truss-fw", model: "m" });
    const { events, finished } = collect(handle);
    try {
      piAdapter.send(handle, "say hi");
      await waitFor(
        () => assistantStarts(events).length === 1 && events.some((e) => e.type === "msg.done"),
        "assistant message done",
      );

      assert.deepEqual(statesOf(events), ["idle", "running", "idle"]);

      const start = assistantStarts(events)[0] as { messageId: string };
      const chunks = events.filter((e) => e.type === "msg.chunk" && e.messageId === start.messageId);
      const textChunks = chunks.filter((c) => (c as { channel?: string }).channel === "text");
      const thinkChunks = chunks.filter((c) => (c as { channel?: string }).channel === "thinking");
      assert.deepEqual(
        textChunks.map((c) => (c as { text: string }).text),
        ["Hello", " world"],
      );
      assert.deepEqual(
        thinkChunks.map((c) => (c as { text: string }).text),
        ["hmm"],
      );

      const done = events.find((e) => e.type === "msg.done" && e.messageId === start.messageId) as {
        stopReason?: string;
      };
      assert.ok(done, "msg.done for the assistant message");
      assert.equal(done.stopReason, undefined, "clean completion carries no stopReason");

      const callStart = events.find((e) => e.type === "llm.call.start") as { model: string; callId: string };
      assert.ok(callStart, "llm.call.start on turn_start");
      assert.equal(callStart.model, "m");
      const callDone = events.find((e) => e.type === "llm.call.done") as {
        status: number;
        tokensIn?: number;
        tokensOut?: number;
        costUsd?: number;
      };
      assert.ok(callDone, "llm.call.done on turn_end");
      assert.equal(callDone.status, 200);
      assert.equal(callDone.tokensIn, 11);
      assert.equal(callDone.tokensOut, 4);
      assert.equal(callDone.costUsd, 0.0001);

      const ctx = events.find((e) => e.type === "ctx.usage") as { used: number; total: number };
      assert.ok(ctx, "ctx.usage from message_update usage.totalTokens");
      assert.equal(ctx.used, 15);
      assert.equal(ctx.total, 200_000, "no catalog entry → default context window");
    } finally {
      await shutdown(handle, finished);
    }
  });
});

test("error surfacing (regression): provider 400 arrives only via message_end stopReason error", { timeout: 15000 }, async () => {
  await withFakePi("boom", async (fake) => {
    const handle = await piAdapter.spawn({ sessionId: "t-boom", cwd: tmpdir(), provider: "truss-fw", model: "m" });
    const { events, finished } = collect(handle);
    try {
      piAdapter.send(handle, "BOOM this model does not exist");
      await waitFor(
        () =>
          events.some(
            (e) =>
              e.type === "msg.done" &&
              typeof (e as { stopReason?: string }).stopReason === "string" &&
              (e as { stopReason: string }).stopReason.includes("Unknown Model"),
          ),
        "msg.done carrying the provider error",
      );

      const start = assistantStarts(events)[0] as { messageId: string };
      const textChunks = events.filter(
        (e) =>
          e.type === "msg.chunk" &&
          e.messageId === start.messageId &&
          (e as { channel?: string }).channel === "text",
      );
      assert.equal(textChunks.length, 0, "failed run produces no assistant text");

      const done = events.find((e) => e.type === "msg.done" && e.messageId === start.messageId) as {
        stopReason?: string;
      };
      assert.ok(done.stopReason, "stopReason must be set (pre-fix behavior closed the bubble silently)");
      assert.ok(done.stopReason.startsWith("error:"), `stopReason starts with "error:" — got: ${done.stopReason}`);
      assert.ok(done.stopReason.includes("Unknown Model"), "provider errorMessage is preserved");

      // the trajectory row stops pretending success: turn_end carries 500
      const callDone = events.find((e) => e.type === "llm.call.done") as { status?: number } | undefined;
      assert.equal(callDone?.status, 500, "failed turn's trajectory row shows 500, not 200");

      // session settles back to idle so the next prompt can go out
      await waitFor(() => statesOf(events).at(-1) === "idle", "back to idle after error");
    } finally {
      await shutdown(handle, finished);
    }
  });
});

test("queueWhileRunning: send during a run writes follow_up (not prompt), queued message runs after", { timeout: 20000 }, async () => {
  await withFakePi("queue", async (fake) => {
    const handle = await piAdapter.spawn({ sessionId: "t-queue", cwd: tmpdir(), provider: "truss-fw", model: "m" });
    const { events, finished } = collect(handle);
    try {
      piAdapter.send(handle, "SLOW first question");
      await waitFor(() => statesOf(events).includes("running"), "first run started");
      piAdapter.send(handle, "second question");

      await waitFor(
        () =>
          assistantStarts(events).length === 2 &&
          events.filter((e) => e.type === "msg.done").length >= 2 &&
          statesOf(events).at(-1) === "idle",
        "both messages complete and session idles",
        12000,
      );

      // what the adapter SENT: exactly one prompt (the first) + one follow_up
      const cmds = logCmds(fake.logPath);
      const prompts = cmds.filter((c) => c.type === "prompt");
      const followUps = cmds.filter((c) => c.type === "follow_up");
      assert.equal(prompts.length, 1, "a bare prompt while streaming would be rejected by pi");
      assert.ok(prompts[0].message?.includes("SLOW first question"));
      assert.equal(followUps.length, 1);
      assert.equal(followUps[0].message, "second question");

      // the queued message gets its own run: msg.start #2 strictly after msg.done #1
      const starts = assistantStarts(events) as { messageId: string }[];
      const firstDoneIdx = events.findIndex((e) => e.type === "msg.done" && e.messageId === starts[0].messageId);
      const secondStartIdx = events.findIndex((e) => e.type === "msg.start" && e.messageId === starts[1].messageId);
      assert.ok(firstDoneIdx >= 0 && secondStartIdx > firstDoneIdx, "follow-up message starts after the first run finished");

      const secondChunks = events.filter(
        (e) => e.type === "msg.chunk" && e.messageId === starts[1].messageId,
      ) as { text: string }[];
      assert.ok(secondChunks.length > 0, "queued message streamed its own chunks");
    } finally {
      await shutdown(handle, finished);
    }
  });
});

test("abort: interrupt() maps pi's 'aborted' to stopReason 'interrupted' and settles idle", { timeout: 15000 }, async () => {
  await withFakePi("abort", async (fake) => {
    const handle = await piAdapter.spawn({ sessionId: "t-abort", cwd: tmpdir(), provider: "truss-fw", model: "m" });
    const { events, finished } = collect(handle);
    try {
      piAdapter.send(handle, "SLOW abort me");
      await waitFor(() => assistantStarts(events).length === 1, "assistant message started");
      piAdapter.interrupt(handle);

      const start = assistantStarts(events)[0] as { messageId: string };
      await waitFor(
        () =>
          events.some(
            (e) => e.type === "msg.done" && e.messageId === start.messageId && e.stopReason === "interrupted",
          ),
        "msg.done stopReason interrupted",
      );
      await waitFor(() => statesOf(events).at(-1) === "idle", "session idle after abort");

      // adapter sends clear_queue before abort (rpc-commands.md Esc behavior)
      const cmds = logCmds(fake.logPath).map((c) => c.type);
      const cq = cmds.indexOf("clear_queue");
      const ab = cmds.indexOf("abort");
      assert.ok(cq >= 0 && ab > cq, `clear_queue precedes abort — got: ${cmds.join(",")}`);

      // exactly one msg.done for the aborted message (agent_settled must not double-close)
      const dones = events.filter((e) => e.type === "msg.done" && e.messageId === start.messageId);
      assert.equal(dones.length, 1);
    } finally {
      await shutdown(handle, finished);
    }
  });
});

test("dispose: ending stdin shuts pi down cleanly, exit 0, no error events", { timeout: 15000 }, async () => {
  await withFakePi("dispose", async (fake) => {
    const handle = await piAdapter.spawn({ sessionId: "t-dispose", cwd: tmpdir(), provider: "truss-fw", model: "m" });
    const { events, finished } = collect(handle);
    await waitFor(() => handle.harnessRef === "fake-pi-session-1", "handshake done");
    const exitCode = new Promise<number | null>((res) => procOf(handle).on("exit", (c) => res(c)));
    piAdapter.dispose(handle);
    const code = await Promise.race([
      exitCode,
      new Promise<null>((r) => setTimeout(() => r(null), 5000)),
    ]);
    assert.equal(code, 0, "stdin end → orderly shutdown per rpc.md");
    await Promise.race([finished, new Promise((r) => setTimeout(r, 3000))]);
    const errors = events.filter((e) => e.type === "session.state" && (e as { state: string }).state === "error");
    assert.deepEqual(errors, [], "no error events after dispose");
  });
});

/* ── effort write vs. a dead pipe (issue #27) ──
   The adapter defers set_thinking_level until get_state answers (up to 8s).
   dispose() must tear that down, and a late write into a dead stdin must
   never take the server down. */

test("effort: dispose() before get_state answers must not write set_thinking_level into the ended pipe", { timeout: 15000 }, async () => {
  await withFakePi(
    "effort-dispose",
    async (fake) => {
      const handle = await piAdapter.spawn({
        sessionId: "t-effort-dispose",
        cwd: tmpdir(),
        provider: "truss-fw",
        model: "m",
        effort: "high",
      });
      const { finished } = collect(handle);
      piAdapter.dispose(handle); // stdin ends while the handshake is still in flight
      /* the late get_state answer lands here: harnessRef proves the deferred
         continuation really ran after dispose */
      await waitFor(() => handle.harnessRef === "fake-pi-session-1", "late handshake answer");
      const sent = readLog(fake.logPath).map((r) => r.cmd).filter(Boolean) as { type?: string }[];
      assert.ok(!sent.some((c) => c.type === "set_thinking_level"), "no effort write after dispose");
      /* the test process surviving is the other half: the write must be
         guarded off, not left to whatever the stream does with it */
      await Promise.race([finished, new Promise((r) => setTimeout(r, 1000))]);
    },
    { FAKE_PI_GET_STATE_DELAY: "400", FAKE_PI_IGNORE_END: "1" },
  );
});

/* Node absorbs a write into a dead child's stdin today (it errors instead of
   emitting), so this is a characterization pin rather than red/green: should
   that ever turn into a stream 'error' again, the listener in spawn() keeps
   it from being an uncaught exception here. */
test("a late write into a dead stdin neither throws nor crashes the server", { timeout: 15000 }, async () => {
  await withFakePi("deadpipe", async () => {
    const handle = await piAdapter.spawn({ sessionId: "t-deadpipe", cwd: tmpdir(), provider: "truss-fw", model: "m" });
    const { finished } = collect(handle);
    await waitFor(() => handle.harnessRef === "fake-pi-session-1", "handshake done");
    procOf(handle).kill("SIGKILL");
    await new Promise((r) => (procOf(handle).once("exit", () => r(null))));
    /* the 8s effort continuation, send() and interrupt() all land here after
       a harness dies mid-flight */
    procOf(handle).stdin!.write("late\n");
    await new Promise((r) => setTimeout(r, 100));
    await Promise.race([finished, new Promise((r) => setTimeout(r, 1000))]);
    assert.equal(handle.harnessRef, "fake-pi-session-1", "the run got as far as the handshake");
  });
});

test("model without provider resolves via ~/.pi/agent/models.json catalog (resume regression)", { timeout: 15000 }, async () => {
  const piCfgDir = join(FAKE_HOME, ".pi", "agent");
  mkdirSync(piCfgDir, { recursive: true });
  const modelsJson = join(piCfgDir, "models.json");
  writeFileSync(
    modelsJson,
    JSON.stringify({ providers: { "my-prov": { models: [{ id: "m-x", name: "X" }] } } }),
  );
  try {
    await withFakePi("catalog", async (fake) => {
      const handle = await piAdapter.spawn({ sessionId: "t-catalog", cwd: tmpdir(), model: "m-x" });
      const { events, finished } = collect(handle);
      try {
        await waitFor(() => handle.harnessRef === "fake-pi-session-1", "handshake done");
        const argv = logArgv(fake.logPath);
        assert.equal(flagValue(argv, "--provider"), "my-prov", "provider recovered from catalog, not the zai-local default");
        assert.equal(flagValue(argv, "--model"), "m-x");
      } finally {
        await shutdown(handle, finished);
      }
    });
  } finally {
    rmSync(join(FAKE_HOME, ".pi"), { recursive: true, force: true });
  }
});

/* restore the ambient env for any other test files sharing this process */
test.after(() => {
  if (OLD_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = OLD_HOME;
  if (OLD_DATA === undefined) delete process.env.TRUSS_DATA_DIR;
  else process.env.TRUSS_DATA_DIR = OLD_DATA;
  rmSync(ROOT, { recursive: true, force: true });
});

test("setModel: live switch sends set_model, later turns use the new model, unknown model rejects", { timeout: 15000 }, async () => {
  await withFakePi("setmodel", async (fake) => {
    const handle = await piAdapter.spawn({ sessionId: "t-setmodel", cwd: tmpdir(), provider: "truss-fw", model: "m" });
    const { events, finished } = collect(handle);
    try {
      /* baseline turn on the original model (nb: spawn emits idle first —
         wait for the RUN to cycle, not just any idle) */
      piAdapter.send(handle, "first");
      await waitFor(
        () => events.some((e) => e.type === "llm.call.done") && statesOf(events).at(-1) === "idle",
        "first run settled",
      );
      const firstCall = events.find((e) => e.type === "llm.call.start") as { model?: string };
      assert.equal(firstCall.model, "m");

      /* live switch — no respawn, no new session */
      await piAdapter.setModel!(handle, "truss-fw", "m2");
      const sent = readLog(fake.logPath).map((r) => r.cmd).filter(Boolean) as { type?: string; provider?: string; modelId?: string }[];
      const sm = sent.find((c) => c.type === "set_model");
      assert.ok(sm, "set_model reached the harness");
      assert.equal(sm!.provider, "truss-fw");
      assert.equal(sm!.modelId, "m2");

      /* next turn is labeled with the new model in the trajectory */
      piAdapter.send(handle, "second");
      await waitFor(() => events.filter((e) => e.type === "llm.call.start").length === 2, "second turn started");
      const starts = events.filter((e) => e.type === "llm.call.start") as { model?: string }[];
      assert.equal(starts[1].model, "m2");
      await waitFor(
        () => events.filter((e) => e.type === "llm.call.done").length === 2 && statesOf(events).at(-1) === "idle",
        "second run settled",
      );

      /* failure path: pi says Model not found -> the adapter throws */
      await assert.rejects(() => piAdapter.setModel!(handle, "truss-fw", "NOPE-x"), /Model not found/);
    } finally {
      await shutdown(handle, finished);
    }
  });
});

test("a fast double-send in the agent_start gap never writes two bare prompts (issue #40)", { timeout: 20000 }, async () => {
  await withFakePi("race", async (fake) => {
    const handle = await piAdapter.spawn({ sessionId: "t-race", cwd: tmpdir(), provider: "truss-fw", model: "m" });
    const { events, finished } = collect(handle);
    try {
      /* both sends in the same tick — before agent_start can flip busy.
         Pre-fix the second went out as a bare prompt and pi rejected it. */
      piAdapter.send(handle, "first");
      piAdapter.send(handle, "second");

      await waitFor(
        () => assistantStarts(events).length === 2 && statesOf(events).at(-1) === "idle",
        "both messages run to completion",
        12000,
      );
      const cmds = logCmds(fake.logPath);
      const prompts = cmds.filter((c) => c.type === "prompt");
      const followUps = cmds.filter((c) => c.type === "follow_up");
      assert.equal(prompts.length, 1, "exactly one bare prompt — the gap is closed");
      assert.equal(prompts[0].message, "first");
      assert.deepEqual(followUps.map((c) => c.message), ["second"], "the second queues instead of being rejected");
    } finally {
      piAdapter.dispose(handle);
      await finished;
    }
  });
});
