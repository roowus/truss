import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

/**
 * Full-loop server harness: boots the REAL fastify app in-process (ephemeral
 * port, temp TRUSS_DATA_DIR, fake HOME so pi-config sync writes into the temp
 * tree, fake `pi` binary first on PATH so adapter spawns never touch the real
 * harness or a paid API). One boot per test FILE (each file is its own
 * process under node --test).
 *
 *   const srv = await bootServer("loop");
 *   const r = await fetch(`${srv.base}/api/sessions`, {...});
 *   ... await srv.close();
 */
export interface TestServer {
  app: FastifyInstance;
  base: string;
  wsBase: string;
  dir: string;
  close: () => Promise<void>;
}

export async function bootServer(tag: string): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), `truss-server-${tag}-`));
  process.env.TRUSS_DATA_DIR = join(dir, "data");
  process.env.HOME = join(dir, "home");
  mkdirSync(process.env.HOME, { recursive: true });
  process.env.TRUSS_PORT = "0"; // ephemeral
  process.env.TRUSS_TEST = "1";
  process.env.TRUSS_AGENT_TOKEN = "test-shared-token";

  installFakePi(dir);

  const mod = await import("../src/index.js");
  const app = mod.app;
  await app.ready();
  await new Promise((r) => setTimeout(r, 150)); // listen() races ready()
  const addr = app.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    app,
    base: `http://127.0.0.1:${port}`,
    wsBase: `ws://127.0.0.1:${port}`,
    dir,
    close: async () => {
      /* adapter children (fake pis) keep the loop alive unless disposed —
         app.close() alone doesn't do it (that path only runs on signals) */
      try {
        const sessions = await import("../src/sessions.js");
        const { store } = await import("../src/db.js");
        for (const row of store.listSessions()) {
          try {
            sessions.closeSession(row.id);
          } catch {
            /* already dead */
          }
        }
      } catch {
        /* best effort */
      }
      await app.close();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* sqlite handles linger; tmp reaped by the OS */
      }
    },
  };
}

/** the canned RPC fake from the pi adapter tests, as a PATH-shadowing binary */
export function installFakePi(dir: string): void {
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const fakePi = `#!/usr/bin/env node
"use strict";
/* fake pi --mode rpc for truss full-loop tests */
const fs = require("fs");
const logPath = process.env.FAKE_PI_LOG;
const log = (rec) => { if (logPath) fs.appendFileSync(logPath, JSON.stringify(rec) + "\\n"); };
log({ argv: process.argv.slice(2), cwd: process.cwd() });
const out = (rec) => process.stdout.write(JSON.stringify(rec) + "\\n");
const USAGE = { input: 11, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.0001 } };
let running = false;
let timers = [];
const later = (ms, fn) => { timers.push(setTimeout(fn, ms)); };
const cancelTimers = () => { for (const t of timers) clearTimeout(t); timers = []; };
function asst(stopReason, errorMessage) {
  const m = { role: "assistant", content: [], stopReason, timestamp: Date.now() };
  if (errorMessage) m.errorMessage = errorMessage;
  return m;
}
function finishRun(stopReason, errorMessage) {
  cancelTimers();
  out({ type: "message_end", message: asst(stopReason, errorMessage) });
  if (stopReason !== "aborted") out({ type: "turn_end", message: asst(stopReason, errorMessage), toolResults: [] });
  out({ type: "agent_end", messages: [], willRetry: false });
  out({ type: "agent_settled" });
  running = false;
}
function run(text) {
  if (text.indexOf("BOOM") !== -1) {
    running = true;
    out({ type: "agent_start" });
    later(20, () => {
      out({ type: "turn_start" });
      out({ type: "message_start", message: asst("pending") });
    });
    later(60, () => finishRun("error", '400: {"code":"1211","message":"Unknown Model"}'));
    return;
  }
  running = true;
  out({ type: "agent_start" });
  later(10, () => {
    out({ type: "turn_start" });
    out({ type: "message_start", message: { role: "user", content: text, timestamp: Date.now() } });
    out({ type: "message_end", message: { role: "user", content: text, timestamp: Date.now() } });
    out({ type: "message_start", message: asst("pending") });
    out({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "thinking…" } });
  });
  later(35, () => out({ type: "message_update", usage: USAGE, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "REPLY:" + text.slice(0, 40) } }));
  later(70, () => finishRun("stop"));
}
function handle(cmd) {
  const id = cmd.id;
  switch (cmd.type) {
    case "get_state":
      out({ type: "response", id, command: "get_state", success: true, data: { sessionId: "fake-pi-session-1", isStreaming: running } });
      break;
    case "prompt":
      if (running) { out({ type: "response", id, command: "prompt", success: false, error: "agent is streaming" }); break; }
      out({ type: "response", id, command: "prompt", success: true });
      run(String(cmd.message || ""));
      break;
    case "set_model":
      out({ type: "response", id, command: "set_model", success: true, data: { model: { provider: cmd.provider, id: cmd.modelId } } });
      break;
    case "clear_queue":
      out({ type: "response", id, command: "clear_queue", success: true, data: { steering: [], followUp: [] } });
      break;
    case "abort":
      if (running) finishRun("aborted");
      out({ type: "response", id, command: "abort", success: true });
      break;
    default:
      out({ type: "response", id, command: cmd.type, success: true });
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
    try { cmd = JSON.parse(line); } catch { continue; }
    log({ cmd });
    handle(cmd);
  }
});
process.stdin.on("end", () => process.exit(0));
`;
  const bin = join(binDir, "pi");
  writeFileSync(bin, fakePi);
  chmodSync(bin, 0o755);
  process.env.PATH = `${binDir}:${process.env.PATH}`;
  /* pi session dir + models catalog inside the fake home */
  mkdirSync(join(dir, "home", ".pi", "agent"), { recursive: true });
  writeFileSync(
    join(dir, "home", ".pi", "agent", "models.json"),
    JSON.stringify({
      providers: {
        "test-prov": { models: [{ id: "m-fast", name: "Fast", contextWindow: 123456 }, { id: "m-big", name: "Big" }] },
      },
    }),
  );
}

/** poll until pred() is truthy (predicates may be async — awaited per tick) */
export async function waitFor<T>(fn: () => T | Promise<T>, what = "condition", timeoutMs = 8000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** minimal WS client for /events and /agent/connect (node 22 has WebSocket) */
export async function openWs(url: string): Promise<{ frames: Record<string, unknown>[]; close: () => void; send: (o: unknown) => void }> {
  const ws = new WebSocket(url);
  const frames: Record<string, unknown>[] = [];
  ws.onmessage = (e) => {
    try {
      frames.push(JSON.parse(String(e.data)));
    } catch {
      /* non-json */
    }
  };
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("ws connect failed"));
  });
  return {
    frames,
    close: () => ws.close(),
    send: (o) => ws.send(JSON.stringify(o)),
  };
}
