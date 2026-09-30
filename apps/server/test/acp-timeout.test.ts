import { test } from "node:test";
import assert from "node:assert/strict";
import { freshServer } from "./helpers.js";
import type { AdapterHandle, HarnessAdapter, SessionOpts } from "../src/adapters/types.js";

/* SPEC-TESTS for ACP request timeouts — https://github.com/roowus/truss/issues/12
   ("Spawning a hermes session took over 10m03s"). These FAIL on purpose
   today: they pin the contract a fix must satisfy.

   Root cause candidate (see the issue for the live repro numbers):
   AcpClient.call (apps/server/src/adapters/acp.ts:147-154) returns a promise
   that pends FOREVER when the server never answers — no timeout anywhere on
   the initialize / session/new path. A hermes-acp that stalls during
   session/new (e.g. attaching the truss MCP server) wedges the spawn until
   something downstream gives up — the user measured 10m03s.

   The contract:

   - new AcpClient(launch, { requestTimeoutMs }) — a per-request budget.
     A call whose answer never arrives REJECTS with a "timed out" error at
     the budget instead of pending forever.
   - ACP_DEFAULT_TIMEOUT_MS is exported and sane (10s–120s): a spawn can
     never wedge for ten minutes by default.
   - ensure() respects the budget for its internal initialize, and after a
     timeout the client can be RETRIED (ready resets) — no permanently
     poisoned singleton.
   - Happy path unchanged: a responsive server initializes and answers
     calls well inside the budget.

   The fake servers are `node -e` one-liners — no real harness is spawned.
   Each test kills the client's child process in `finally` (the client's
   `proc` is private; tests reach in — leaking it would hold the test
   process open). */

interface AcpClientLike {
  ensure(): Promise<void>;
  call(method: string, params: unknown): Promise<unknown>;
}

/* consume stdin, never answer — the wedged harness */
const DEAD_SERVER = `process.stdin.on("data",()=>{});`;
/* answer ONLY initialize; everything else pends — isolates call() timeouts
   from ensure()'s own initialize */
const INIT_ONLY_SERVER = `let b="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>{b+=c;let i;while((i=b.indexOf("\\n"))>=0){const l=b.slice(0,i).trim();b=b.slice(i+1);if(!l)continue;let r;try{r=JSON.parse(l)}catch{continue}if(r.id!=null&&r.method==="initialize"){process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:r.id,result:{protocolVersion:1}})+"\\n")}}});`;
/* answer every request: initialize gets a protocolVersion, everything else {ok:true} */
const ECHO_SERVER = `let b="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>{b+=c;let i;while((i=b.indexOf("\\n"))>=0){const l=b.slice(0,i).trim();b=b.slice(i+1);if(!l)continue;let r;try{r=JSON.parse(l)}catch{continue}if(r.id!=null&&r.method){process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:r.id,result:r.method==="initialize"?{protocolVersion:1}:{ok:true}})+"\\n")}}});`;

const NODE = process.execPath;

async function makeClient(kind: "dead" | "echo" | "init-only", opts?: { requestTimeoutMs?: number }): Promise<{ client: AcpClientLike; kill: () => void }> {
  const { AcpClient } = await import("../src/adapters/acp.js");
  const script = kind === "dead" ? DEAD_SERVER : kind === "init-only" ? INIT_ONLY_SERVER : ECHO_SERVER;
  const client: AcpClientLike =
    // the options argument is the new contract — the cast keeps this file
    // typechecking before it exists
    new (AcpClient as unknown as new (launch: { command: string; args: string[] }, o?: { requestTimeoutMs?: number }) => AcpClientLike)(
      { command: NODE, args: ["-e", script] },
      opts,
    );
  return { client, kill: () => (client as any).proc?.kill("SIGKILL") };
}

function deadClient(timeoutMs: number) {
  return makeClient("dead", { requestTimeoutMs: timeoutMs });
}

test("a call whose answer never comes rejects as timed out — it must not pend forever", async () => {
  /* server answers initialize (so ensure() succeeds and the process is
     healthy) but never answers anything else — isolates call()'s timeout */
  const { client, kill } = await makeClient("init-only", { requestTimeoutMs: 300 });
  try {
    await client.ensure();
    const outcome = await Promise.race([
      client.call("session/new", { cwd: "/tmp", mcpServers: [] }).then(
        () => "resolved",
        (e: Error) => `rejected: ${e.message}`,
      ),
      new Promise<string>((r) => setTimeout(() => r("still pending at 3s"), 3000)),
    ]);
    assert.match(outcome, /^rejected: .*timed ?out/i, `a wedged server must fail fast — got: ${outcome} (today it pends forever; the user waited 10m03s)`);
  } finally {
    kill();
  }
});

test("ensure() times out its own initialize, then lets the caller RETRY (no poisoned singleton)", async () => {
  const { client, kill } = await deadClient(300);
  try {
    const first = await Promise.race([
      client.ensure().then(() => "resolved", (e: Error) => `rejected: ${e.message}`),
      new Promise<string>((r) => setTimeout(() => r("still pending at 3s"), 3000)),
    ]);
    assert.match(first, /^rejected: /, `ensure() with a dead server must reject — got: ${first}`);

    const t = Date.now();
    const second = await client.ensure().then(
      () => "resolved",
      (e: Error) => `rejected: ${e.message}`,
    );
    assert.match(second, /^rejected: /, "a retry re-attempts and rejects again");
    assert.ok(Date.now() - t < 3000, "the retry must actually re-run (not return a stuck promise)");
  } finally {
    kill();
  }
});

test("ACP_DEFAULT_TIMEOUT_MS is exported and sane — a spawn can never wedge for 603s by default", async () => {
  const acp = await import("../src/adapters/acp.js");
  const dflt = (acp as any).ACP_DEFAULT_TIMEOUT_MS as number | undefined;
  assert.equal(typeof dflt, "number", "acp.ts must export ACP_DEFAULT_TIMEOUT_MS — see issue #12");
  assert.ok(dflt! >= 10_000, "generous enough for cold python/model boots");
  assert.ok(dflt! <= 120_000, "two minutes, not ten-plus");
});

test("happy path unchanged: a responsive server initializes and answers promptly", async () => {
  const { client, kill } = await makeClient("echo", { requestTimeoutMs: 5_000 });
  try {
    const t = Date.now();
    await client.ensure();
    const res = (await client.call("session/new", { cwd: "/tmp", mcpServers: [] })) as { ok?: boolean };
    assert.equal(res?.ok, true, "echo server answered the call");
    assert.ok(Date.now() - t < 4_000, "responsive servers stay fast — the budget never slows the happy path");
  } finally {
    kill();
  }
});

/* ── sessions layer: the spawn itself must have a budget and a failure state ── */

function spawnNeverAdapter(id: string): HarnessAdapter {
  return {
    id: id as never,
    capabilities: { permissions: false, subagents: false, streaming: true, queueWhileRunning: true },
    async listModels() {
      return [];
    },
    spawn(_opts: SessionOpts): Promise<AdapterHandle> {
      return new Promise(() => {}); // the wedged hermes spawn — never resolves
    },
    send() {},
    interrupt() {},
    async *events() {
      await new Promise(() => {});
      yield undefined as never;
    },
    dispose() {},
  };
}

test("createSession bounds the spawn: a wedged adapter rejects with a timeout, session flips to error (not eternal 'spawning')", async () => {
  const { db, cleanup } = await freshServer("spawn-budget");
  const sessions = await import("../src/sessions.js");
  sessions.registerAdapter("fake-wedged" as never, spawnNeverAdapter("fake-wedged"));
  try {
    const outcome = await Promise.race([
      (sessions.createSession as any)({ harness: "fake-wedged", cwd: "/tmp" }, { spawnTimeoutMs: 300 }).then(
        () => "resolved",
        (e: Error) => `rejected: ${e.message}`,
      ),
      new Promise<string>((r) => setTimeout(() => r("still pending at 4s"), 4000)),
    ]);
    assert.match(outcome, /^rejected: .*(timed ?out|timeout|spawn)/i, `a wedged spawn must fail fast and loud — got: ${outcome} (today: 'Booting…' forever)`);

    const stuck = db.store.listSessions().find((s) => s.harness === "fake-wedged");
    assert.ok(stuck, "the session row exists");
    assert.equal(stuck!.state, "error", "a failed spawn leaves an ERROR to click away from, not an eternal spinner");
  } finally {
    sessions.unregisterAdapter("fake-wedged" as never);
    cleanup();
  }
});

test("a rejected spawn marks the session error instead of leaving it 'spawning' forever", async () => {
  const { db, cleanup } = await freshServer("spawn-fail");
  const sessions = await import("../src/sessions.js");
  const failAdapter: HarnessAdapter = {
    ...spawnNeverAdapter("fake-failspawn"),
    spawn: () => Promise.reject(new Error("hermes-acp exploded on boot")),
  };
  sessions.registerAdapter("fake-failspawn" as never, failAdapter);
  try {
    await assert.rejects(() => sessions.createSession({ harness: "fake-failspawn" as never, cwd: "/tmp" }), /exploded/);
    const row = db.store.listSessions().find((s) => s.harness === ("fake-failspawn" as never));
    assert.ok(row, "the row survives so the UI can show what happened");
    assert.equal(row!.state, "error", "not 'spawning' — the spinner must stop somewhere truthful");
  } finally {
    sessions.unregisterAdapter("fake-failspawn" as never);
    cleanup();
  }
});
