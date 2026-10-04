import { test } from "node:test";
import assert from "node:assert/strict";
import { freshServer } from "./helpers.js";

/* remote.ts — node-agent registry + frame router. Agents register via
   agentHello(hostId, hostname, adapters, socket) where socket is just
   {send, close} — a recording stub stands in for the real websocket, so the
   metrics request/response flow is fully testable. remote.ts keeps
   module-level Maps shared across this file's tests: unique host ids per
   test, and agentBye() to unregister. RemoteAdapter.spawn() is deliberately
   NOT exercised — its 30s ack timer is never cleared and would hold the test
   process open (noted gap). */

const CAPS = { permissions: false, subagents: false, streaming: true, queueWhileRunning: true };

function fakeSocket(sent: string[]) {
  return { send: (s: string) => void sent.push(s), close: () => {} };
}

test("agentHello registers adapters as <id>@<host> and listAgents shows the agent", async () => {
  const { cleanup } = await freshServer("rem-hello");
  try {
    const remote = await import("../src/remote.js");
    const registered: string[] = [];
    remote.wireRemoteRegistry({
      register: (id) => void registered.push(String(id)),
      unregister: () => {},
      sessionGone: () => {},
    });

    remote.agentHello("h-alice", "alice-host", [{ id: "pi", capabilities: CAPS }], fakeSocket([]));
    assert.deepEqual(registered, ["pi@h-alice"], "adapter registered under host-scoped id");

    const a = remote.listAgents().find((x) => x.hostId === "h-alice");
    assert.ok(a, "agent listed");
    assert.equal(a.hostname, "alice-host");
    assert.deepEqual(a.adapters, ["pi"]);

    remote.agentBye("h-alice");
    assert.ok(!remote.listAgents().some((x) => x.hostId === "h-alice"), "gone after bye");
  } finally {
    cleanup();
  }
});

test("agentBye unregisters the host's adapters; bye on an unknown host is a no-op", async () => {
  const { cleanup } = await freshServer("rem-bye");
  try {
    const remote = await import("../src/remote.js");
    const unregistered: string[] = [];
    remote.wireRemoteRegistry({
      register: () => {},
      unregister: (id) => void unregistered.push(String(id)),
      sessionGone: () => {},
    });

    remote.agentHello(
      "h-bob",
      "bob-host",
      [
        { id: "pi", capabilities: CAPS },
        { id: "dsh", capabilities: CAPS },
      ],
      fakeSocket([]),
    );
    remote.agentBye("h-bob");
    assert.deepEqual(unregistered.sort(), ["dsh@h-bob", "pi@h-bob"], "both adapters unregistered");
    assert.ok(!remote.listAgents().some((x) => x.hostId === "h-bob"));

    remote.agentBye("h-never-connected"); // must not throw
  } finally {
    cleanup();
  }
});

test("requestMetrics sends metrics_req and resolves when agentFrame answers", async () => {
  const { cleanup } = await freshServer("rem-metrics");
  try {
    const remote = await import("../src/remote.js");
    const sent: string[] = [];
    remote.agentHello("h-met", "met-host", [], fakeSocket(sent));
    try {
      const p = remote.requestMetrics("h-met", 500);
      assert.equal(sent.length, 1, "one frame went out");
      const frame = JSON.parse(sent[0]) as { type: string; reqId: string };
      assert.equal(frame.type, "metrics_req");
      assert.ok(typeof frame.reqId === "string" && frame.reqId.length > 0, "carries a reqId");
      assert.deepEqual(Object.keys(frame).sort(), ["reqId", "type"], "no extra fields");

      const m = { cpu: 0.42, memMb: 512, sessions: 2 };
      remote.agentFrame("h-met", { type: "metrics", reqId: frame.reqId, m });
      assert.deepEqual(await p, m, "resolves with the agent's payload");
    } finally {
      remote.agentBye("h-met");
    }
  } finally {
    cleanup();
  }
});

test("requestMetrics rejects with a timeout when the agent never answers", async () => {
  const { cleanup } = await freshServer("rem-timeout");
  try {
    const remote = await import("../src/remote.js");
    const sent: string[] = [];
    remote.agentHello("h-silent", "silent-host", [], fakeSocket(sent));
    try {
      await assert.rejects(() => remote.requestMetrics("h-silent", 60), /metrics timeout/);
      assert.equal(sent.length, 1, "the request was sent before timing out");
      assert.equal((JSON.parse(sent[0]) as { type: string }).type, "metrics_req");
    } finally {
      remote.agentBye("h-silent");
    }
  } finally {
    cleanup();
  }
});

test("requestMetrics rejects for unknown hosts; agentFrame ignores stray frames", async () => {
  const { cleanup } = await freshServer("rem-unknown");
  try {
    const remote = await import("../src/remote.js");

    await assert.rejects(() => remote.requestMetrics("h-ghost", 50), /not connected/);

    // none of these may throw — the router must be robust against stray frames
    remote.agentFrame("h-ghost", { type: "nonsense", foo: 1 });
    remote.agentFrame("h-ghost", { type: "hello" }); // handled at the route; no-op here
    remote.agentFrame("h-ghost", { type: "metrics", reqId: "m-999", m: {} }); // no waiter
    remote.agentFrame("h-ghost", { type: "spawned", reqId: "spawn-999", ok: true }); // no waiter
    remote.agentFrame("h-ghost", {
      type: "event",
      sessionId: "s-no-queue",
      ev: { type: "msg.done", sessionId: "s-no-queue" },
    });
  } finally {
    cleanup();
  }
});

test("a spawn waiter is rejected fast when its agent drops mid-spawn (no 30s lie)", async () => {
  const { cleanup } = await freshServer("rem-spawn-drop");
  try {
    const remote = await import("../src/remote.js");
    let adapter: any = null;
    remote.wireRemoteRegistry({
      register: (id, a) => {
        adapter = a;
      },
      unregister: () => {},
      sessionGone: () => {},
    });
    const socket = fakeSocket([]);
    remote.agentHello("h-drop", "drop-host", [{ id: "pi", capabilities: CAPS }], socket);
    /* the spawn frame goes out; the agent dies before acking */
    const outcome = adapter
      .spawn({ sessionId: "s-drop", cwd: "/tmp" })
      .then(() => "resolved", (e: Error) => e.message);
    remote.agentBye("h-drop", socket);
    assert.match(await outcome, /disconnected/, "the waiter hears the truth immediately (issue #100, item 10)");
  } finally {
    cleanup();
  }
});

test("a replaced connection's stale close cannot reap the new registration", async () => {
  const { cleanup } = await freshServer("rem-stale-close");
  try {
    const remote = await import("../src/remote.js");
    remote.wireRemoteRegistry({ register: () => {}, unregister: () => {}, sessionGone: () => {} });
    const oldSock = fakeSocket([]);
    const newSock = fakeSocket([]);
    remote.agentHello("h-race", "race-host", [{ id: "pi", capabilities: CAPS }], oldSock);
    /* the agent reconnects; the OLD socket's close event lands after */
    remote.agentHello("h-race", "race-host", [{ id: "pi", capabilities: CAPS }], newSock);
    remote.agentBye("h-race", oldSock);
    assert.ok(remote.listAgents().some((x) => x.hostId === "h-race"), "the live registration survives the stale close");
    remote.agentBye("h-race", newSock);
    assert.ok(!remote.listAgents().some((x) => x.hostId === "h-race"), "the real close still reaps");
  } finally {
    cleanup();
  }
});

test("protocol-1 agents reap their sessions at disconnect; protocol-2 sessions wait for reattach (audit B5)", async () => {
  const { cleanup } = await freshServer("rem-proto-reap");
  try {
    const remote = await import("../src/remote.js");
    let adapter: any = null;
    const gone: string[] = [];
    remote.wireRemoteRegistry({
      register: (id, a) => {
        adapter = a;
      },
      unregister: () => {},
      sessionGone: (id) => void gone.push(id),
    });

    const spawnOn = async (host: string, socket: ReturnType<typeof fakeSocket>, sid: string, meta?: { protocol: number }) => {
      const sent = (socket as any).__sent ?? [];
      remote.agentHello(host, `${host}-host`, [{ id: "pi", capabilities: CAPS }], socket, meta as never);
      const p = adapter.spawn({ sessionId: sid, cwd: "/tmp" });
      const frame = JSON.parse(sent[sent.length - 1]) as { reqId: string };
      remote.agentFrame(host, { type: "spawned", reqId: frame.reqId, ok: true });
      await p;
    };

    /* protocol 1 (hello carried no version handshake): its sessions died with
       the tunnel — reap at the blip, the pre-#100 behavior */
    const s1sent: string[] = [];
    const s1 = fakeSocket(s1sent);
    (s1 as any).__sent = s1sent;
    await spawnOn("h-p1", s1, "s-p1");
    remote.agentBye("h-p1", s1);
    assert.deepEqual(gone, ["s-p1"], "protocol-1 session reaped at the blip");

    /* protocol 2: the agent kept the harness alive — nothing reaps until the
       next hello's reconcile */
    const s2sent: string[] = [];
    const s2 = fakeSocket(s2sent);
    (s2 as any).__sent = s2sent;
    await spawnOn("h-p2", s2, "s-p2", { protocol: 2 });
    remote.agentBye("h-p2", s2);
    assert.deepEqual(gone, ["s-p1"], "protocol-2 session survives the blip");
  } finally {
    cleanup();
  }
});
