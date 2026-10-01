import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshServer, tick } from "./helpers.js";
import type { AdapterHandle, HarnessAdapter, SessionOpts } from "../src/adapters/types.js";
import type { ProtoEvent } from "@truss/proto";

/* CONTRACT TESTS for ACP request timeouts — https://github.com/roowus/truss/issues/12
   ("Spawning a hermes session took over 10m03s"). The contract below is
   IMPLEMENTED in AcpClient and these tests pin it — every test here is
   green at this head.

   What the fix does (see the issue for the live repro numbers that shaped
   it): AcpClient.call budgets each request, so a hermes-acp that stalls
   during session/new (e.g. attaching the truss MCP server) rejects at the
   budget instead of wedging the spawn for ten minutes. The budget covers the
   spawn-phase and control calls; the turn call opts out, because a turn is
   as long as the agent needs.

   The contract:

   - new AcpClient(launch, { requestTimeoutMs }) — a per-request budget.
     A call whose answer never arrives REJECTS with a "timed out" error at
     the budget instead of pending forever.
   - call(method, params, timeoutMs) — a per-call override; 0 runs the call
     unbudgeted. session/prompt uses it: a turn past the budget must still
     complete, or every long turn fails and loses its output.
   - ACP_DEFAULT_TIMEOUT_MS is exported and sane (10s–120s): a spawn can
     never wedge for ten minutes by default.
   - ensure() respects the budget for its internal initialize, and after a
     timeout the client can be RETRIED (ready resets, and the killed boot's
     exit never touches the retried process) — no permanently poisoned
     singleton.
   - Happy path unchanged: a responsive server initializes and answers
     calls well inside the budget.

   The fake servers are `node -e` one-liners — no real harness is spawned.
   Each test kills the client's child process in `finally` (the client's
   `proc` is private; tests reach in — leaking it would hold the test
   process open). */

interface AcpClientLike {
  ensure(): Promise<void>;
  call(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
}

/* consume stdin, never answer — the wedged harness */
const DEAD_SERVER = `process.stdin.on("data",()=>{});`;
/* answer ONLY initialize; everything else pends — isolates call() timeouts
   from ensure()'s own initialize */
const INIT_ONLY_SERVER = `let b="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>{b+=c;let i;while((i=b.indexOf("\\n"))>=0){const l=b.slice(0,i).trim();b=b.slice(i+1);if(!l)continue;let r;try{r=JSON.parse(l)}catch{continue}if(r.id!=null&&r.method==="initialize"){process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:r.id,result:{protocolVersion:1}})+"\\n")}}});`;
/* answer every request: initialize gets a protocolVersion, everything else {ok:true} */
const ECHO_SERVER = `let b="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>{b+=c;let i;while((i=b.indexOf("\\n"))>=0){const l=b.slice(0,i).trim();b=b.slice(i+1);if(!l)continue;let r;try{r=JSON.parse(l)}catch{continue}if(r.id!=null&&r.method){process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:r.id,result:r.method==="initialize"?{protocolVersion:1}:{ok:true}})+"\\n")}}});`;
/* answer initialize after TRUSS_TEST_BOOT_DELAY ms (the child inherits the
   test's env at spawn, so each boot picks its own delay): the boot that times
   out is killed while still alive, so its exit event lands near a retry's
   own boot. With TRUSS_TEST_PARTIAL set it also writes a newline-less half
   frame at boot — a killed boot that had already flushed part of an answer. */
const SLOW_INIT_SERVER = `let b="";if(process.env.TRUSS_TEST_PARTIAL){process.stdout.write('{"jsonrpc":"2.0","id":"ghost","result":{"protocolVersion":1}}')}const d=+(process.env.TRUSS_TEST_BOOT_DELAY||400);process.stdin.setEncoding("utf8");process.stdin.on("data",c=>{b+=c;let i;while((i=b.indexOf("\\n"))>=0){const l=b.slice(0,i).trim();b=b.slice(i+1);if(!l)continue;let r;try{r=JSON.parse(l)}catch{continue}if(r.id!=null&&r.method==="initialize"){setTimeout(()=>{process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:r.id,result:{protocolVersion:1}})+"\\n")},d)}}});`;
/* answer ONLY initialize and a late session/prompt; every other method pends —
   isolates the turn call's opt-out from the budget control calls still have */
const SLOW_PROMPT_SERVER = `let b="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>{b+=c;let i;while((i=b.indexOf("\\n"))>=0){const l=b.slice(0,i).trim();b=b.slice(i+1);if(!l)continue;let r;try{r=JSON.parse(l)}catch{continue}if(r.id!=null&&r.method==="initialize"){process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:r.id,result:{protocolVersion:1}})+"\\n")}else if(r.id!=null&&r.method==="session/prompt"){setTimeout(()=>{process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:r.id,result:{ok:true}})+"\\n")},600)}}});`;

const NODE = process.execPath;

/* a stand-in hermes-acp for the adapter-level turn test: initialize +
   session/new answer fast, session/prompt answers after 300ms (the shape of a
   real agent turn), then the process exits. The adapter pins its binary path
   when its module first loads — and sessions.ts imports it — so the fake is
   written and TRUSS_HERMES_BIN pointed at it HERE, before any test imports
   sessions.js. Only the turn test ever calls its spawn. */
const HERMES_FAKE = `let b="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>{b+=c;let i;while((i=b.indexOf("\\n"))>=0){const l=b.slice(0,i).trim();b=b.slice(i+1);if(!l)continue;let r;try{r=JSON.parse(l)}catch{continue}if(r.id!=null&&r.method){let res={ok:true};if(r.method==="initialize")res={protocolVersion:1};if(r.method==="session/new")res={sessionId:"hs-fake-1"};if(r.method==="session/prompt"){setTimeout(()=>{process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:r.id,result:res})+"\\n",()=>process.exit(0))},300)}else{process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:r.id,result:res})+"\\n")}}}});`;
const HERMES_FAKE_DIR = mkdtempSync(join(tmpdir(), "truss-fake-hermes-"));
const HERMES_FAKE_BIN = join(HERMES_FAKE_DIR, "hermes-acp");
writeFileSync(HERMES_FAKE_BIN, "#!/usr/bin/env node\n" + HERMES_FAKE + "\n", { mode: 0o755 });
process.env.TRUSS_HERMES_BIN = HERMES_FAKE_BIN;

async function makeClient(kind: "dead" | "echo" | "init-only" | "slow-init" | "slow-prompt", opts?: { requestTimeoutMs?: number }): Promise<{ client: AcpClientLike; kill: () => void }> {
  const { AcpClient } = await import("../src/adapters/acp.js");
  const script =
    kind === "dead"
      ? DEAD_SERVER
      : kind === "init-only"
        ? INIT_ONLY_SERVER
        : kind === "slow-init"
          ? SLOW_INIT_SERVER
          : kind === "slow-prompt"
            ? SLOW_PROMPT_SERVER
            : ECHO_SERVER;
  const client: AcpClientLike = new AcpClient({ command: NODE, args: ["-e", script] }, opts);
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

test("a retry after a boot timeout succeeds — the killed boot's exit must not touch the new process", async () => {
  /* the first boot answers initialize at 900ms, past the 150ms budget: it
     times out and is SIGKILLed while still alive, so its exit event lands
     just after the retry has spawned and written its own initialize. The
     retry must boot on the healthy second process — not be rejected by the
     dead boot's exit handler and get its child killed in turn. The answer is
     seconds past the budget on purpose: the ordering is real timers, and a
     loaded runner must not be able to invert it. */
  const { client, kill } = await makeClient("slow-init", { requestTimeoutMs: 150 });
  try {
    process.env.TRUSS_TEST_BOOT_DELAY = "900";
    const first = await client.ensure().then(() => "resolved", (e: Error) => `rejected: ${e.message}`);
    assert.match(first, /^rejected: .*timed ?out/i, `the slow first boot times out — got: ${first}`);
    process.env.TRUSS_TEST_BOOT_DELAY = "10";
    const second = await client.ensure().then(() => "resolved", (e: Error) => `rejected: ${e.message}`);
    assert.equal(second, "resolved", `the retry must complete on the healthy second boot — got: ${second}`);
  } finally {
    delete process.env.TRUSS_TEST_BOOT_DELAY;
    kill();
  }
});

test("a timed-out boot's child is dead — the failed boot must not leave a harness process behind", async () => {
  /* the kill in ensure()'s failure path is behavior, not hygiene: without it
     every timed-out boot leaks a process that holds its pipes (and, on a
     real harness, a python interpreter) until truss exits. Deleting the
     SIGKILL must fail HERE, not just slow the runner down. */
  const { client, kill } = await makeClient("slow-init", { requestTimeoutMs: 150 });
  process.env.TRUSS_TEST_BOOT_DELAY = "900";
  try {
    /* the child is on the client from the moment ensure() is called (spawn
       runs before the boot's first await). It has to be picked up here: the
       recycle forgets the process the instant the budget fires, so it is no
       longer reachable through the client afterwards. */
    const booting = client.ensure();
    const ghost = (client as any).proc;
    assert.ok(ghost, "the boot leaves its child where the test can see it");
    const first = await booting.then(() => "resolved", (e: Error) => `rejected: ${e.message}`);
    assert.match(first, /^rejected: .*timed ?out/i, `the slow boot times out — got: ${first}`);
    await tick(100);
    assert.ok(
      ghost.exitCode !== null || ghost.signalCode !== null,
      `the timed-out boot's child must be killed, not left running — exitCode=${ghost.exitCode}, signal=${ghost.signalCode}`,
    );
  } finally {
    delete process.env.TRUSS_TEST_BOOT_DELAY;
    kill();
  }
});

test("a retry after a killed boot reads its own first frame — the ghost's partial frame must not prefix it", async () => {
  /* the first boot flushes half a frame (no newline) and is killed with it
     still sitting in the client's read buffer. The retry's initialize answer
     then lands behind that tail: without a buffer reset the two parse as one
     unparseable line, the answer is dropped silently, and the retry burns
     its own budget against a healthy process. */
  const { client, kill } = await makeClient("slow-init", { requestTimeoutMs: 150 });
  try {
    process.env.TRUSS_TEST_PARTIAL = "1";
    process.env.TRUSS_TEST_BOOT_DELAY = "900";
    const first = await client.ensure().then(() => "resolved", (e: Error) => `rejected: ${e.message}`);
    assert.match(first, /^rejected: .*timed ?out/i, `the partial-frame boot times out and is killed — got: ${first}`);
    delete process.env.TRUSS_TEST_PARTIAL;
    process.env.TRUSS_TEST_BOOT_DELAY = "10";
    const second = await client.ensure().then(() => "resolved", (e: Error) => `rejected: ${e.message}`);
    assert.equal(second, "resolved", `the retry must read the new child's own initialize answer — got: ${second}`);
  } finally {
    delete process.env.TRUSS_TEST_PARTIAL;
    delete process.env.TRUSS_TEST_BOOT_DELAY;
    kill();
  }
});

test("a wedged spawn-phase call recycles the process — the next ensure() boots fresh instead of reusing it", async () => {
  /* the server answers initialize and then never answers anything else: the
     exact shape of a harness that wedges attaching its MCP servers. The
     client must not keep that process cached as ready — every later
     create/resume would pay the whole budget against it again. With a live
     session's handler or another call on the process, the same timeout must
     leave it alone: the process is shared. */
  const { client, kill } = await makeClient("init-only", { requestTimeoutMs: 200 });
  try {
    await client.ensure();
    const wedged = (client as any).proc;
    const control = await client.call("session/new", { cwd: "/tmp", mcpServers: [] }).then(
      () => "resolved",
      (e: Error) => `rejected: ${e.message}`,
    );
    assert.match(control, /^rejected: .*timed ?out/i, `the wedged call times out — got: ${control}`);
    await tick(100);
    assert.ok(
      wedged.exitCode !== null || wedged.signalCode !== null,
      `the wedged process must be recycled, not left cached and dead-weight — exitCode=${wedged.exitCode}, signal=${wedged.signalCode}`,
    );
    /* the exit handler cleared the cached boot, so the next ensure() really
       boots — point it at a healthy server to prove the new child is a new
       child (the client's launch object is the seam) */
    (client as any).launch.args = ["-e", ECHO_SERVER];
    await client.ensure();
    const fresh = (client as any).proc;
    assert.ok(fresh && fresh !== wedged, "a later ensure() must boot a new process, not return the wedged one");
    const answered = await client.call("session/new", { cwd: "/tmp", mcpServers: [] }).then(
      () => "resolved",
      (e: Error) => `rejected: ${e.message}`,
    );
    assert.equal(answered, "resolved", "the fresh process answers");
  } finally {
    kill();
  }
});

test("a spawn-phase timeout does not recycle a process a live session is using", async () => {
  /* the recycle is only safe when nothing else is on the process: a session
     that is live and whose control call wedged must survive the timeout. */
  const { client, kill } = await makeClient("init-only", { requestTimeoutMs: 200 });
  try {
    await client.ensure();
    const live = (client as any).proc;
    (client as any).onSession("hs-shared", () => {});
    await client.call("session/new", { cwd: "/tmp", mcpServers: [] }).catch(() => undefined);
    await tick(100);
    assert.equal(
      live.exitCode === null && live.signalCode === null,
      true,
      "a shared process must survive one session's wedged call",
    );
    assert.equal((client as any).proc, live, "the client keeps serving the live session");
  } finally {
    kill();
  }
});

test("the turn call opts out of the budget — session/prompt answered past it still completes", async () => {
  /* one client, 300ms budget: a control call that never answers rejects at
     the budget, but the turn call (0 = unbudgeted) settles when the harness
     settles — at 600ms here, past the budget. Budgeting the turn is what
     made every turn over a minute fail and lose its output. The frame
     handler below is what a live session registers at spawn; with a session
     on the process, a wedged control call must not recycle it. */
  const { client, kill } = await makeClient("slow-prompt", { requestTimeoutMs: 300 });
  try {
    await client.ensure();
    (client as any).onSession("hs-1", () => {});
    const control = await client.call("session/new", { cwd: "/tmp", mcpServers: [] }).then(
      () => "resolved",
      (e: Error) => `rejected: ${e.message}`,
    );
    assert.match(control, /^rejected: .*timed ?out/i, "control calls stay budgeted");
    const turn = await client.call("session/prompt", { sessionId: "hs-1", prompt: [] }, 0).then(
      () => "resolved",
      (e: Error) => `rejected: ${e.message}`,
    );
    assert.equal(turn, "resolved", `a turn past the budget must complete — got: ${turn}`);
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

test("after the harness process dies, a session can register its frame handler again", async () => {
  /* onSession is first-live-wins so a late-landing timed-out spawn can't
     steal a live session's frames — but the dead process's handlers must go
     with it, or every resume after a crash would register nothing and go
     deaf. */
  const { client, kill } = await makeClient("echo", { requestTimeoutMs: 5_000 });
  try {
    await client.ensure();
    const first = () => {};
    (client as any).onSession("hs-1", first);
    assert.equal((client as any).ownsSession("hs-1", first), true, "the first registration owns the session");

    kill(); // the current process exits for real — its handlers are stale
    await tick(50);
    const second = () => {};
    (client as any).onSession("hs-1", second);
    assert.equal(
      (client as any).ownsSession("hs-1", second),
      true,
      "a resume after the harness died must be able to re-register — the stale owner is gone",
    );
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

test("the spawn-budget message is user-facing copy: it names the phase and carries no em dash", async () => {
  /* the message is sunk as the session row's error detail and shown verbatim
     in the web UI — TRUSS.md bans em dashes in user-facing copy */
  const { cleanup } = await freshServer("spawn-budget-copy");
  const sessions = await import("../src/sessions.js");
  sessions.registerAdapter("fake-wedged-copy" as never, spawnNeverAdapter("fake-wedged-copy"));
  try {
    const message = await new Promise<string>((resolve) => {
      (sessions.createSession as any)({ harness: "fake-wedged-copy", cwd: "/tmp" }, { spawnTimeoutMs: 150 }).then(
        () => resolve("resolved"),
        (e: Error) => resolve(e.message),
      );
    });
    assert.match(
      message,
      /didn't answer spawn within \d+s/,
      `the message must say which phase gave up — got: ${message}`,
    );
    assert.ok(
      !message.includes("—"),
      `copy the user reads must not carry an em dash (TRUSS.md) — got: ${message}`,
    );
  } finally {
    sessions.unregisterAdapter("fake-wedged-copy" as never);
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

/* ── the turn itself must survive the budget ── */

test("a hermes turn settles through send() against a fake ACP server", async () => {
  const { hermesAdapter } = await import("../src/adapters/hermes.js");
  let h: AdapterHandle | null = null;
  try {
    h = await hermesAdapter.spawn({ sessionId: "t-turn", cwd: "/tmp" });
    hermesAdapter.send(h, "hello");
    /* the turn settles when llm.call.done lands — the spawn's own
       session.state idle is already in the queue before the turn starts */
    const seen: ProtoEvent[] = [];
    const settled = (async () => {
      for await (const ev of hermesAdapter.events(h!)) {
        seen.push(ev);
        if (ev.type === "llm.call.done") return;
      }
    })();
    const outcome = await Promise.race([
      settled.then(() => "settled"),
      new Promise<string>((r) => setTimeout(() => r("never settled"), 4000)),
    ]);
    assert.equal(
      outcome,
      "settled",
      `the turn must settle on the prompt's own answer — got: ${outcome}; events: ${JSON.stringify(seen)}`,
    );
    const done = seen.find((e) => e.type === "llm.call.done") as { status?: number } | undefined;
    assert.equal(done?.status, 200, "the turn closes 200, not the 500 of a failed budget");
    const msg = seen.find((e) => e.type === "msg.done") as { stopReason?: string } | undefined;
    assert.ok(msg, "the assistant message closes");
    assert.equal(msg!.stopReason, undefined, "it closes as a finished turn, not an error");
  } finally {
    if (h) hermesAdapter.dispose(h);
    try {
      rmSync(HERMES_FAKE_DIR, { recursive: true, force: true });
    } catch {
      /* the fake may still be exiting; tmp dirs get reaped anyway */
    }
  }
});

test("both adapters wire the turn opt-out: send() issues session/prompt with 0 (unbudgeted)", async () => {
  /* the client-level override is pinned above, but the wiring lives in the
     adapters — drop the 0 from either one and this fails, where the fake's
     300ms answer against the 60s default budget would have stayed green */
  const acp = await import("../src/adapters/acp.js");
  const hermes = await import("../src/adapters/hermes.js");
  const dsh = await import("../src/adapters/dsh.js");
  const cases = [
    ["hermes", hermes.hermesAdapter, hermes.client],
    ["dsh", dsh.dshAdapter, dsh.client],
  ] as const;
  for (const [name, adapter, client] of cases) {
    const budgets: unknown[] = [];
    (client as any).call = (method: string, _params: unknown, timeoutMs?: number) => {
      if (method === "session/prompt") budgets.push(timeoutMs);
      return Promise.resolve({}); // settle the turn without a server
    };
    try {
      const h = acp.makeSessionState(`t-wire-${name}`, `acp-wire-${name}`, "m");
      adapter.send(h, "hello");
      await tick(20);
      assert.deepEqual(
        budgets,
        [0],
        `${name} must pass the turn call unbudgeted — budgeting the turn is the exact regression this PR fixes`,
      );
    } finally {
      delete (client as any).call;
    }
  }
});

/* ── every spawn path is bounded, and a budget timeout orphans nothing ── */

test("the spawn budget doesn't orphan a harness that lands late — the abandoned handle is disposed", async () => {
  const { cleanup } = await freshServer("spawn-late");
  const sessions = await import("../src/sessions.js");
  let disposed = 0;
  const lateAdapter: HarnessAdapter = {
    ...spawnNeverAdapter("fake-late"),
    /* outlives the budget, then lands a live child — the shape of a cold
       python boot that just missed the deadline */
    spawn: () => new Promise<AdapterHandle>((res) => setTimeout(() => res({ sessionId: "late-1" }), 500)),
    dispose: () => {
      disposed++;
    },
  };
  sessions.registerAdapter("fake-late" as never, lateAdapter);
  try {
    await assert.rejects(() =>
      sessions.createSession({ harness: "fake-late" as never, cwd: "/tmp" }, { spawnTimeoutMs: 200 }),
    );
    assert.equal(disposed, 0, "nothing to dispose before the late spawn lands");
    await tick(600);
    assert.equal(disposed, 1, "the late handle is disposed instead of leaking the harness process");
  } finally {
    sessions.unregisterAdapter("fake-late" as never);
    cleanup();
  }
});

test("a spawn that throws synchronously fails cleanly — it must not leave the budget timer rejecting nothing", async () => {
  /* registerAdapter is the seam runtime harnesses plug into, so an adapter
     can throw before returning a promise. The old shape armed the budget
     timer outside the try: the throw skipped the finally, and when the timer
     fired it rejected a promise nobody awaits — fatal under Node's default
     unhandled-rejection mode, minutes after the actual failure. */
  const { cleanup } = await freshServer("spawn-sync-throw");
  const sessions = await import("../src/sessions.js");
  const syncThrow: HarnessAdapter = {
    ...spawnNeverAdapter("fake-sync"),
    spawn(): Promise<AdapterHandle> {
      throw new Error("spawn blew up before returning a promise");
    },
  };
  sessions.registerAdapter("fake-sync" as never, syncThrow);
  const unhandled: unknown[] = [];
  const onUnhandled = (err: unknown) => unhandled.push(err);
  process.on("unhandledRejection", onUnhandled);
  try {
    await assert.rejects(
      () => sessions.createSession({ harness: "fake-sync" as never, cwd: "/tmp" }, { spawnTimeoutMs: 50 }),
      /blew up/,
      "the sync throw must surface as the spawn's own rejection",
    );
    await tick(150); // past the 50ms budget — an armed timer would have fired by now
    assert.equal(
      unhandled.length,
      0,
      `the budget timer must be disowned with the spawn — got unhandled rejections: ${unhandled.map(String).join("; ")}`,
    );
  } finally {
    process.off("unhandledRejection", onUnhandled);
    sessions.unregisterAdapter("fake-sync" as never);
    cleanup();
  }
});

test("resumeSession is bounded too: a wedged spawn returns false instead of hanging forever", async () => {
  const { db, cleanup } = await freshServer("resume-budget");
  const sessions = await import("../src/sessions.js");
  sessions.registerAdapter("fake-resume" as never, spawnNeverAdapter("fake-resume"));
  try {
    /* a closed session with a harness ref — exactly what resume spawns for */
    db.store.createSession({ id: "res-1", harness: "fake-resume" as never, title: "t", cwd: "/tmp" });
    db.store.setHarnessRef("res-1", "hr-1");
    const outcome = await Promise.race([
      sessions.resumeSession("res-1", { spawnTimeoutMs: 300 }).then(
        (ok: boolean) => `returned ${ok}`,
        (e: Error) => `rejected: ${e.message}`,
      ),
      new Promise<string>((r) => setTimeout(() => r("still pending at 3s"), 3000)),
    ]);
    assert.equal(outcome, "returned false", `a wedged resume must give up fast — got: ${outcome}`);
  } finally {
    sessions.unregisterAdapter("fake-resume" as never);
    cleanup();
  }
});

test("two resumes racing inside the spawn window share one spawn — no second spawn on the same ref", async () => {
  /* sendPrompt's auto-resume is reachable from the HTTP route, the websocket
     and the MCP tool, so two prompts can land while the first resume is still
     spawning. Two spawns on one stored ref race for the harness session key:
     the first to register owns it, the second is refused — and the refused
     one is the handle goLive leaves live, so its permission cards silently
     no-op and nothing can ever dispose the key holder. One resume in flight
     per session kills the race at the source. */
  const { db, cleanup } = await freshServer("resume-dedupe");
  const sessions = await import("../src/sessions.js");
  let spawns = 0;
  const adapter: HarnessAdapter = {
    ...spawnNeverAdapter("fake-dedupe"),
    /* a slow spawn: both callers are in flight together, exactly the window
       two prompts into a dead session land in */
    spawn: (opts: SessionOpts) => {
      spawns++;
      return new Promise<AdapterHandle>((res) =>
        setTimeout(() => res({ sessionId: opts.sessionId, harnessRef: "hr-dedupe" }), 120),
      );
    },
  };
  sessions.registerAdapter("fake-dedupe" as never, adapter);
  try {
    db.store.createSession({ id: "dedupe-1", harness: "fake-dedupe" as never, title: "t", cwd: "/tmp" });
    db.store.setHarnessRef("dedupe-1", "hr-dedupe");
    const [a, b] = await Promise.all([
      sessions.resumeSession("dedupe-1", { spawnTimeoutMs: 4000 }),
      sessions.resumeSession("dedupe-1", { spawnTimeoutMs: 4000 }),
    ]);
    assert.equal(a, true, "the first resume goes live on the stored ref");
    assert.equal(b, true, "the second prompt rides the same in-flight resume");
    assert.equal(spawns, 1, `one spawn per session id while a resume is in flight — got ${spawns}`);
    assert.ok(sessions.isLive("dedupe-1"), "the session is live for the caller that waited");
  } finally {
    sessions.unregisterAdapter("fake-dedupe" as never);
    sessions.closeSession("dedupe-1");
    cleanup();
  }
});

test("a resume can start again once the previous one finished — the in-flight guard must not stick", async () => {
  const { db, cleanup } = await freshServer("resume-dedupe-release");
  const sessions = await import("../src/sessions.js");
  let spawns = 0;
  const adapter: HarnessAdapter = {
    ...spawnNeverAdapter("fake-dedupe-release"),
    spawn: (opts: SessionOpts) => {
      spawns++;
      return Promise.resolve({ sessionId: opts.sessionId, harnessRef: "hr-dedupe" });
    },
  };
  sessions.registerAdapter("fake-dedupe-release" as never, adapter);
  try {
    db.store.createSession({ id: "dedupe-2", harness: "fake-dedupe-release" as never, title: "t", cwd: "/tmp" });
    db.store.setHarnessRef("dedupe-2", "hr-dedupe");
    assert.equal(await sessions.resumeSession("dedupe-2"), true, "first resume goes live");
    /* a later resume after the session went dead again must not be handed the
       settled promise — the guard covers the spawn window, nothing longer */
    sessions.closeSession("dedupe-2");
    assert.equal(await sessions.resumeSession("dedupe-2"), true, "the next resume runs for real");
    assert.equal(spawns, 2, "each settled resume releases the slot for the next");
  } finally {
    sessions.unregisterAdapter("fake-dedupe-release" as never);
    sessions.closeSession("dedupe-2");
    cleanup();
  }
});

test("a timed-out model-switch respawn flips the row to error — a stale 'idle' refuses every later prompt", async () => {
  /* switchModel drops the live handle BEFORE respawning, so unlike
     createSession the failure used to leave the row reading whatever it had
     before the switch — "idle" for any live session — while nothing served
     it. sendPrompt's closed/error gate then refused the session on every
     later try: the wedge moved from "spawning forever" to "idle forever". */
  const { db, cleanup } = await freshServer("switch-flip");
  const sessions = await import("../src/sessions.js");
  let spawns = 0;
  const sent: string[] = [];
  /* like the real ACP adapters, the spawn carries its own frames, flips the
     row idle itself, and persists a harness ref — exactly the state the
     failed respawn must not leave standing, and the ref the resume gate
     needs once the row reads error */
  interface FakeHandle extends AdapterHandle {
    frames: AsyncIterable<ProtoEvent>;
  }
  const adapter: HarnessAdapter = {
    ...spawnNeverAdapter("fake-switch-flip"),
    events: (h: AdapterHandle) => (h as FakeHandle).frames,
    send: (_h: AdapterHandle, text: string) => {
      sent.push(text);
    },
    spawn: (opts: SessionOpts) => {
      spawns++;
      /* 2 is the respawn that blows the budget, 3 the auto-resume it leaves
         the row error for, 4 the retry that recovers the session */
      if (spawns === 2) return new Promise<AdapterHandle>(() => {});
      if (spawns === 3) return Promise.reject(new Error("wedged again"));
      const handle = {
        sessionId: opts.sessionId,
        harnessRef: "hr-flip",
        frames: (async function* () {
          yield { type: "session.state", sessionId: opts.sessionId, state: "idle" };
        })(),
      };
      return Promise.resolve(handle as AdapterHandle);
    },
  };
  sessions.registerAdapter("fake-switch-flip" as never, adapter);
  try {
    const s = await sessions.createSession({ harness: "fake-switch-flip" as never, cwd: "/tmp" });
    await assert.rejects(() => sessions.switchModel(s.id, "m2", "p2", { spawnTimeoutMs: 300 }));
    const row = db.store.listSessions().find((r) => r.id === s.id);
    assert.equal(
      row!.state,
      "error",
      `the row must stop reading idle once the harness session is gone — got: ${row!.state}`,
    );
    /* the flip is what opens sendPrompt's resume gate: the row now reads
       error and still carries the first spawn's harness ref, so the next
       prompt really attempts the auto-resume (spawn 3) instead of being
       refused with the old permanent "session is idle" */
    await assert.rejects(() => sessions.sendPrompt(s.id, "hello"), /session is error/);
    assert.equal(spawns, 3, "the gate opened: sendPrompt attempted the auto-resume");
    assert.deepEqual(sent, [], "a failed auto-resume must not deliver the prompt");
    /* and the truthful row pays off: the next prompt resumes the session */
    await sessions.sendPrompt(s.id, "hello again");
    assert.equal(spawns, 4, "the second try resumes the session");
    assert.equal(sent.length, 1, "the prompt is delivered once the session is back");
  } finally {
    sessions.unregisterAdapter("fake-switch-flip" as never);
    cleanup();
  }
});

/* ── the child's own 'error' event ────────────────────────────────────────

   Node emits 'error' on the ChildProcess when the binary cannot be spawned
   at all: a wrong TRUSS_HERMES_BIN, or dsh missing from PATH. An
   EventEmitter 'error' with no listener THROWS, and that throw is the truss
   server's uncaughtException — the whole server dies instead of landing the
   error row the failed spawn was about to produce, and ensure()'s retry
   contract becomes a crash loop. The same is true of a write that outruns
   the child's death: this PR is what SIGKILLs children by design, so
   call()'s unguarded write can land in a pipe whose reader just went away,
   and EPIPE on a stream with no 'error' listener is the same unhandled
   throw. pi.ts and claude.ts both attach a child 'error' handler; the shared
   ACP client is the one adapter seam every ACP harness goes through. Every
   test in this section would have crashed the runner before the fix —
   reaching its assertions IS the regression pin. */

test("a binary that cannot spawn rejects the boot and leaves the server running", async () => {
  const { AcpClient } = await import("../src/adapters/acp.js");
  const client = new AcpClient(
    { command: join(tmpdir(), "truss-no-such-harness-binary"), args: [] },
    { requestTimeoutMs: 2000 },
  );
  try {
    const outcome = await client.ensure().then(() => "resolved", (e: Error) => `rejected: ${e.message}`);
    assert.match(
      outcome,
      /^rejected/,
      `an unspawnable binary must reject the boot (the caller lands the error row) — got: ${outcome}`,
    );
    assert.equal((client as any).proc, null, "a boot that never started leaves no process cached");
    /* and the client stays retryable: the settled failure must not be handed
       back forever, or one wrong TRUSS_HERMES_BIN poisons the client until
       truss restarts */
    (client as any).launch.command = NODE;
    (client as any).launch.args = ["-e", ECHO_SERVER];
    const retry = await client.ensure().then(() => "resolved", (e: Error) => `rejected: ${e.message}`);
    assert.equal(retry, "resolved", `a retry after an unspawnable binary must boot for real — got: ${retry}`);
  } finally {
    (client as any).proc?.kill("SIGKILL");
  }
});

test("the child and its stdin carry 'error' listeners — an EPIPE or a failed spawn must not be an unhandled throw", async () => {
  /* structural on purpose: whether a write actually EPIPEs depends on the
     kernel tearing the pipe down before it lands, so the survival test below
     can pass on a run where the race never fired. The listener is the fix. */
  const { AcpClient } = await import("../src/adapters/acp.js");
  const { client, kill } = await makeClient("echo", { requestTimeoutMs: 2000 });
  try {
    await client.ensure();
    const child = (client as any).proc;
    assert.ok(child, "the boot left a child to inspect");
    assert.ok(child.listenerCount("error") > 0, "the ChildProcess itself must have an 'error' listener");
    assert.ok(child.stdin.listenerCount("error") > 0, "the child's stdin must have an 'error' listener");
  } finally {
    kill();
  }
});

test("a write racing the child's death surfaces as a rejection — it must not take the server down", async () => {
  const { client, kill } = await makeClient("echo", { requestTimeoutMs: 2000 });
  try {
    await client.ensure();
    const child = (client as any).proc;
    child.kill("SIGKILL");
    /* this.proc is still set until the exit handler runs, so this call writes
       into a pipe whose reader just died. Whatever the pipe does with it, the
       write must surface through the call's own rejection — reaching this
       assertion is the pin. */
    const outcome = await client.call("session/new", { cwd: "/tmp", mcpServers: [] }).then(
      () => "resolved",
      (e: Error) => `rejected: ${e.message}`,
    );
    assert.match(
      outcome,
      /^rejected/,
      `a write into a dying pipe must reject the call, not crash the server — got: ${outcome}`,
    );
    await tick(100);
    assert.ok(
      child.exitCode !== null || child.signalCode !== null,
      `the killed child is really dead — exitCode=${child.exitCode}, signal=${child.signalCode}`,
    );
  } finally {
    kill();
  }
});

test("a spawn arriving in the recycle window is not handed the dying process", async () => {
  /* the recycle SIGKILLs the child, but this.ready stayed resolved until the
     exit event ran, so an ensure() landing in that gap returned the dying
     boot and wrote its first request into a pipe with no reader — a spawn a
     retry would have carried came back as "acp server exited" and flipped
     the row to error. The window is one event-loop turn wide: right after
     the timed-out call rejects we are still inside it, because the exit
     event needs a loop turn of its own. */
  const { client, kill } = await makeClient("init-only", { requestTimeoutMs: 200 });
  try {
    await client.ensure();
    const wedged = (client as any).proc;
    await assert.rejects(
      () => client.call("session/new", { cwd: "/tmp", mcpServers: [] }),
      /timed ?out/,
      "the wedged call times out and recycles",
    );
    assert.equal(
      (client as any).proc,
      null,
      "the recycle must forget the dying process here, not wait for its exit event",
    );
    /* a call in the same window is refused outright instead of being written
       into the pipe of a process that is already gone */
    const refused = await client.call("session/new", { cwd: "/tmp", mcpServers: [] }).then(
      () => "resolved",
      (e: Error) => `rejected: ${e.message}`,
    );
    assert.match(
      refused,
      /^rejected: acp server not running/,
      `a call in the recycle window must be refused, not written into the dead pipe — got: ${refused}`,
    );
    /* and the spawn that does arrive in the window really boots */
    (client as any).launch.args = ["-e", ECHO_SERVER];
    await client.ensure();
    const fresh = (client as any).proc;
    assert.ok(fresh && fresh !== wedged, "a spawn in the recycle window gets a fresh process, not the dying one");
    kill();
    wedged.kill("SIGKILL");
  } finally {
    kill();
  }
});

test("switchModel's respawn is bounded too: a wedged restart rejects instead of hanging forever", async () => {
  const { cleanup } = await freshServer("switch-budget");
  const sessions = await import("../src/sessions.js");
  let spawns = 0;
  const adapter: HarnessAdapter = {
    ...spawnNeverAdapter("fake-switch"),
    spawn: () => {
      spawns++;
      return spawns === 1 ? Promise.resolve({ sessionId: "sw-1" }) : new Promise(() => {});
    },
  };
  sessions.registerAdapter("fake-switch" as never, adapter);
  try {
    const s = await sessions.createSession({ harness: "fake-switch" as never, cwd: "/tmp" });
    const outcome = await Promise.race([
      sessions.switchModel(s.id, "m2", "p2", { spawnTimeoutMs: 300 }).then(
        () => "resolved",
        (e: Error) => `rejected: ${e.message}`,
      ),
      new Promise<string>((r) => setTimeout(() => r("still pending at 3s"), 3000)),
    ]);
    assert.match(
      outcome,
      /^rejected: .*(spawn|wedged|timed ?out)/i,
      `a wedged model-switch respawn must fail fast — got: ${outcome}`,
    );
  } finally {
    sessions.unregisterAdapter("fake-switch" as never);
    cleanup();
  }
});
