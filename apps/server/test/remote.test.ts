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
