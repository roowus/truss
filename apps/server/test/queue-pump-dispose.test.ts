import { test } from "node:test";
import assert from "node:assert/strict";
import { freshServer, tick } from "./helpers.js";

/* issue #218 — the tunnel queue torn down by the wedge must actually dispose
   the remote harness, exactly once.

   Audit round 2's B3 found `dropWedgedQueue` sent its own `dispose` frame and
   then `q.close()`, which ends the goLive for-await and makes the pump's
   `finally` send a SECOND one. The duplicate was removed, leaving the pump as
   the single owner — so this test exists to pin that the single remaining path
   really does dispose, through the REAL pump.

   A pump only exists for sessions created via `createSession` (goLive is
   private and nothing else starts it), so this registers a fake tunnel
   adapter and drives that path rather than spawning directly. */

const CAPS = { permissions: false, subagents: false, streaming: true, queueWhileRunning: true };

/** a remote-shaped adapter: its events() is the queue under test */
function fakeTunnelAdapter(sessionId: string, sendToAgent: (line: object) => void) {
  const queue = new (class {
    private buf: unknown[] = [];
    private waiters: ((r: IteratorResult<unknown>) => void)[] = [];
    private closed = false;
    push(ev: unknown) {
      const w = this.waiters.shift();
      if (w) w({ value: ev, done: false });
      else this.buf.push(ev);
    }
    close() {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
    }
    [Symbol.asyncIterator]() {
      return {
        next: (): Promise<IteratorResult<unknown>> => {
          const head = this.buf.shift();
          if (head !== undefined) return Promise.resolve({ value: head, done: false });
          if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
          return new Promise((res) => this.waiters.push(res));
        },
      };
    }
  })();

  return {
    queue,
    adapter: {
      id: "pi@dispose-host",
      capabilities: CAPS,
      async listModels() {
        return [];
      },
      async spawn() {
        return { sessionId, hostId: "dispose-host" };
      },
      send() {},
      interrupt() {},
      resolve() {},
      events() {
        return queue as AsyncIterable<never>;
      },
      dispose() {
        /* the remote adapter's real dispose sends this frame — that is the
           observable proof the pump disposed the handle */
        sendToAgent({ type: "dispose", sessionId });
      },
    },
  };
}

test("the wedge teardown disposes the remote harness exactly ONCE, via the pump (round 2, B3)", async () => {
  const { cleanup } = await freshServer("q218-dispose");
  try {
    const sessions = await import("../src/sessions.js");

    const sent: object[] = [];
    const { queue, adapter } = fakeTunnelAdapter("s-dispose", (line) => void sent.push(line));
    sessions.registerAdapter("pi@dispose-host" as never, adapter as never);

    try {
      await sessions.createSession({ harness: "pi@dispose-host" as never, cwd: "/tmp", title: "dispose" });
      await tick(20); // let the pump attach to events()

      /* the wedge closes the queue; the pump's finally must then dispose */
      queue.close();
      await tick(40);

      const disposes = sent.filter((l) => (l as { type?: string }).type === "dispose");
      assert.equal(
        disposes.length,
        1,
        `the pump must dispose the remote handle exactly once (got ${disposes.length}) — a duplicate dispose is the round-2 B3 finding`,
      );
      assert.equal((disposes[0] as { sessionId?: string }).sessionId, "s-dispose", "for the right session");
    } finally {
      sessions.unregisterAdapter("pi@dispose-host" as never);
    }
  } finally {
    cleanup();
  }
});

test("the pump broadcasts a router-persisted frame with its log rowid, not 0 (round 2, B1)", async () => {
  const { cleanup } = await freshServer("q218-pump-seq");
  try {
    const { store } = await import("../src/db.js");
    const sessions = await import("../src/sessions.js");

    const frames: { seq: number; ev: { type: string } }[] = [];
    sessions.setBroadcaster((f) => void frames.push(f as never));

    const sent: object[] = [];
    const { queue, adapter } = fakeTunnelAdapter("s-pump-seq", (line) => void sent.push(line));
    sessions.registerAdapter("pi@dispose-host" as never, adapter as never);

    try {
      const row = await sessions.createSession({ harness: "pi@dispose-host" as never, cwd: "/tmp", title: "seq" });
      await tick(20);

      /* a frame the router would have persisted already: persist it the way
         the router does, then hand the SAME object to the pump's queue */
      const ev = { type: "msg.chunk", sessionId: row.id, messageId: "m1", text: "live" };
      const seq = sessions.persistInboundEvent(ev as never);
      assert.ok(seq !== null, "the frame persisted");
      queue.push(ev);
      await tick(40);

      const live = frames.filter((f) => f.ev.type === "msg.chunk");
      assert.equal(live.length, 1, "the pump broadcast the drained frame");
      assert.equal(
        live[0].seq,
        seq,
        `the live frame carries its log rowid (got ${live[0].seq}, log says ${seq}) — seq 0 is discarded by every hydrated client view`,
      );
      /* and it was not written to the log a second time */
      const logged = store.listEvents(row.id).filter((f) => f.ev.type === "msg.chunk");
      assert.equal(logged.length, 1, "persisted exactly once, not twice");
    } finally {
      sessions.unregisterAdapter("pi@dispose-host" as never);
      sessions.setBroadcaster(() => {});
    }
  } finally {
    cleanup();
  }
});
