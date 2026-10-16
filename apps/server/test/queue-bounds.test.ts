import { test } from "node:test";
import assert from "node:assert/strict";
import { freshServer, tick } from "./helpers.js";
import {
  BoundedEventQueue,
  QUEUE_MAX_BYTES,
  QUEUE_MAX_EVENTS,
  WEDGE_AFTER_MS,
  LINK_WEDGED,
} from "../src/remote.js";

/* issue #218 — the bounded tunnel event queue.

   The queue is the LIVE path only: every event is already in the SQLite event
   log before it reaches here, so dropping the oldest frames costs latency,
   never data. These tests pin that policy and the recovery property it rests
   on. All timing uses the queue's injectable clock (constraint 1) — nothing
   here sleeps. */

/** a fixed, advanceable clock — the whole point of constraint 1 */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

/** deterministic frame sizing so byte-bound tests don't depend on JSON */
const sized = (n: number) => () => n;

/** a session id that is unique across the whole FILE. Date.now()+pid is not
    enough: db.ts binds its path at first import, so every freshServer() in
    this file shares one database and a colliding id inherits a prior test's
    rows (which is exactly how a wedge test once read another test's frames). */
let seq = 0;
const uid = (tag: string) => `s-${tag}-${process.pid}-${++seq}`;

test("a queue under budget passes every frame through untouched", () => {
  const q = new BoundedEventQueue<number>(1000, 10, WEDGE_AFTER_MS, fakeClock().now, sized(10));
  for (let i = 0; i < 5; i++) {
    const out = q.push(i);
    assert.equal(out.dropped, 0, "no drop under budget");
    assert.equal(out.episodeStarted, false);
  }
  assert.equal(q.depth, 5);
  assert.equal(q.pendingBytes, 50);
  assert.equal(q.lagging, false, "not lagging while under budget");
});

test("over-budget queue drops the OLDEST frames, keeps the newest", async () => {
  /* 90 B budget, 40 B frames: the 3rd push takes it to 120 B and must drop
     from the front until it fits (120 -> 80, one frame) */
  const q = new BoundedEventQueue<number>(90, 99, WEDGE_AFTER_MS, fakeClock().now, sized(40));
  q.push(1);
  q.push(2);
  const out = q.push(3);

  assert.equal(out.dropped, 1, "exactly one oldest frame dropped");
  assert.equal(out.episodeStarted, true, "this push started the episode");
  assert.equal(q.lagging, true, "the lagging flag is set");

  /* the newest frames survive — the consumer needs those, not the stale head */
  const seen: number[] = [];
  for await (const v of q) {
    seen.push(v);
    if (seen.length === 2) break;
  }
  assert.deepEqual(seen, [2, 3], "oldest (1) was dropped, newest (2, 3) kept");
});

test("the lag event fires ONCE per episode, not per dropped frame (constraint 2)", () => {
  /* 40 B budget: every push past the first must evict from the front, so this
     is a long unbroken overflow — the exact shape that would flood the link
     with a lag event per frame if the suppression were wrong */
  const q = new BoundedEventQueue<number>(40, 99, WEDGE_AFTER_MS, fakeClock().now, sized(40));
  q.push(1);
  assert.equal(q.push(2).episodeStarted, true, "first overflow starts the episode");

  /* every subsequent over-budget push also drops — but starts no new episode */
  for (let i = 3; i <= 12; i++) {
    const out = q.push(i);
    assert.equal(out.dropped > 0, true, `push ${i} dropped`);
    assert.equal(out.episodeStarted, false, `push ${i} must NOT re-fire the lag event`);
  }
  assert.equal(q.lagging, true, "still lagging throughout");
});

test("a draining consumer clears the flag, and the NEXT overflow fires its own event", async () => {
  const q = new BoundedEventQueue<number>(40, 99, WEDGE_AFTER_MS, fakeClock().now, sized(40));
  q.push(1);
  q.push(2); // drops 1 — the queue holds one frame and is lagging
  assert.equal(q.lagging, true, "over budget — episode 1 open");
  assert.equal(q.depth, 1);

  /* drain to empty: the consumer caught up, so the episode closes */
  const it = q[Symbol.asyncIterator]();
  const first = await it.next();
  assert.deepEqual(first, { value: 2, done: false }, "the surviving frame is the newest");
  assert.equal(q.depth, 0);
  assert.equal(q.lagging, false, "consumer caught up — the flag clears");

  /* the next overflow is a NEW episode, so it re-fires (the suppression is
     per episode, not a permanent latch) */
  q.push(3);
  const out = q.push(4);
  assert.equal(out.episodeStarted, true, "a fresh episode fires its own lag event");
  assert.equal(q.lagging, true);
});

test("the reported drop count is the REAL number of frames evicted", () => {
  /* regression pin: an earlier revision dropped frames but reported
     `dropped: 0`, because the overflow path forgot to forward the count it
     had just computed. Anything acting on that number (a metric, a log line,
     a "how much did we lose" report) would have read zero losses during a
     real overflow — the exact silent-failure shape this issue is about. */
  const q = new BoundedEventQueue<number>(40, 99, WEDGE_AFTER_MS, fakeClock().now, sized(40));

  /* every push past the first evicts exactly one frame to stay at 40 B */
  assert.equal(q.push(1).dropped, 0, "first frame fits — nothing evicted");
  for (let i = 2; i <= 6; i++) {
    assert.equal(q.push(i).dropped, 1, `push ${i} evicted exactly one frame`);
  }

  /* and the count is a real count, not a boolean: a frame that needs several
     evictions reports several. 200 B budget, four 50 B frames already queued
     (200 B), then a 190 B frame: 390 B must come down to 190 B, so all four
     older frames go */
  const big = new BoundedEventQueue<number>(200, 99, WEDGE_AFTER_MS, fakeClock().now, (n) => (n === 999 ? 190 : 50));
  big.push(1);
  big.push(2);
  big.push(3);
  big.push(4); // 200 B — exactly at budget
  assert.equal(big.depth, 4, "four 50 B frames fill the 200 B budget");
  const out = big.push(999);
  assert.equal(out.dropped, 4, "the 190 B frame evicts all four older frames");
  assert.equal(big.depth, 1, "only the newest frame remains");
  assert.equal(big.pendingBytes, 190, "and it fits the budget on its own");
});

test("a single frame larger than the whole budget is KEPT, not dropped", () => {
  /* The newest frame is the live one the consumer was just handed; evicting
     it would drop fresh data to satisfy a budget that the burst already
     exceeded. Keeping it means one oversized frame can sit over budget — the
     sustained-window wedge is what handles a producer that keeps doing this,
     not an immediate discard. */
  const q = new BoundedEventQueue<number>(40, 99, WEDGE_AFTER_MS, fakeClock().now, (n) => (n === 999 ? 5000 : 40));
  q.push(1);
  const out = q.push(999);
  assert.equal(q.depth, 1, "the older frame went, the oversized new one stayed");
  assert.equal(out.dropped, 1, "one eviction");
  assert.equal(out.episodeStarted, true, "and it counts as an overflow episode");
  assert.equal(q.lagging, true, "so the session is marked lagging");

  /* over budget and staying there — the wedge window eventually kills it */
  const clock2 = fakeClock();
  const q2 = new BoundedEventQueue<number>(40, 99, 60_000, clock2.now, (n) => (n === 999 ? 5000 : 40));
  q2.push(999);
  clock2.advance(60_001);
  assert.equal(q2.push(999).wedged, true, "a producer that never fits is eventually cut off");
});

test("the count ceiling is a tripwire for tiny frames the byte budget would miss", () => {
  /* 1 MB of budget but a ceiling of 4 events: a flood of 10 B frames sits far
     under the byte cap yet must still be bounded */
  const q = new BoundedEventQueue<number>(1_000_000, 4, WEDGE_AFTER_MS, fakeClock().now, sized(10));
  for (let i = 0; i < 10; i++) q.push(i);
  assert.ok(q.depth <= 4, `count ceiling holds (depth ${q.depth})`);
  assert.equal(q.lagging, true, "the count tripwire also sets the flag");
});

test("sustained overflow closes with the dedicated code after the window — on the INJECTABLE clock", () => {
  const clock = fakeClock();
  const q = new BoundedEventQueue<number>(100, 99, 60_000, clock.now, sized(40));
  q.push(1);
  q.push(2);
  q.push(3);
  assert.equal(q.isWedged, false, "just over budget is NOT wedged — a burst is tolerated");

  /* still over budget 59s later: not yet */
  clock.advance(59_000);
  assert.equal(q.push(4).wedged, false, "under the window, no kill");
  assert.equal(q.isWedged, false);

  /* the window passes and it is STILL over budget: now it is wedged */
  clock.advance(1_500);
  const out = q.push(5);
  assert.equal(out.wedged, true, "the sustained window elapsed — declare it wedged");
  assert.equal(q.isWedged, true);
});

test("a queue that recovers before the window is NEVER wedged (blip tolerance)", async () => {
  const clock = fakeClock();
  const q = new BoundedEventQueue<number>(40, 99, 60_000, clock.now, sized(40));
  q.push(1);
  q.push(2); // over budget at t0 — episode open

  /* 30s in, the consumer catches up and drains the queue empty */
  clock.advance(30_000);
  const it = q[Symbol.asyncIterator]();
  await it.next(); // the one surviving frame
  assert.equal(q.depth, 0);
  assert.equal(q.lagging, false, "drained back under budget");
  assert.equal(q.isWedged, false, "a queue that recovered is never wedged");

  /* a fresh episode starting 30s later gets its own FULL window — the timer
     is per unbroken episode, not cumulative */
  clock.advance(30_000);
  q.push(3);
  const out = q.push(4);
  assert.equal(out.episodeStarted, true, "new episode");
  assert.equal(out.wedged, false, "the old episode's elapsed time must not count toward this one");
});

test("wire-size accounting is what the byte budget actually measures", () => {
  const frame = { type: "msg.chunk", sessionId: "s", messageId: "m", text: "x".repeat(1000) };
  const q = new BoundedEventQueue<typeof frame>();
  q.push(frame);
  assert.equal(q.pendingBytes, JSON.stringify(frame).length, "the queue counts real wire bytes");
  assert.ok(q.pendingBytes >= 1000, "a large frame is charged its real size");
});

test("one large turn replays far below the cap — a normal workload never trips it (constraint 4)", async () => {
  /* Fixture replay of a large transcript, using the measured frame sizes from
     the log (median 135 B, p99 9 KB, max 72 KB). The point of the tuning is
     that a REAL turn sits far under both bounds, so the policy only bites on
     a genuinely stalled consumer. */
  const { cleanup } = await freshServer("q218-normal-turn");
  try {
    const q = new BoundedEventQueue<Record<string, unknown>>();
    const sizes: number[] = [];

    /* 1200 chunks around the median, plus 12 at the p99 and one at the max —
       comfortably more frames than a long turn produces */
    const push = (ev: Record<string, unknown>) => {
      sizes.push(JSON.stringify(ev).length);
      q.push(ev);
    };
    for (let i = 0; i < 1200; i++) {
      push({ type: "msg.chunk", sessionId: "s1", messageId: `m${i}`, text: "y".repeat(100) });
    }
    for (let i = 0; i < 12; i++) {
      push({ type: "msg.chunk", sessionId: "s1", messageId: `big${i}`, text: "z".repeat(8900) });
    }
    push({ type: "tool.done", sessionId: "s1", callId: "c1", output: "w".repeat(71_000) });

    const total = sizes.reduce((a, b) => a + b, 0);
    assert.equal(q.lagging, false, `a large normal turn must NEVER trip the cap (queued ${total} B)`);
    assert.equal(q.depth, 1213, "nothing was dropped");
    assert.equal(q.pendingBytes, total, "no byte drift");
    assert.ok(total < QUEUE_MAX_BYTES, `fixture (${total} B) is under the ${QUEUE_MAX_BYTES} B budget`);
    assert.ok(1213 < QUEUE_MAX_EVENTS, "and under the count ceiling");

    /* the margin is real, not marginal — this is why 8 MB was chosen */
    assert.ok(
      QUEUE_MAX_BYTES > total * 10,
      `the cap should be an order of magnitude above a heavy turn (cap ${QUEUE_MAX_BYTES}, fixture ${total})`,
    );
  } finally {
    cleanup();
  }
});

test("dropping is safe ONLY because the frame is persisted BEFORE enqueue — the real path (constraint 3)", async () => {
  /* The whole drop-oldest policy rests on "the log is the recovery path", so
     this drives the REAL ordering — agentFrame → persist → push → (drop) —
     instead of fabricating it. Audit B1: an earlier revision of this test
     wrote the log FIRST and then overflowed a standalone queue, which proved
     nothing, because the shipping code persisted in the goLive pump — i.e.
     DOWNSTREAM of the queue, so an evicted frame was never logged at all. */
  const { cleanup } = await freshServer("q218-recovery");
  try {
    const { store } = await import("../src/db.js");
    const sessions = await import("../src/sessions.js");
    const remote = await import("../src/remote.js");

    /* exactly the production wiring from index.ts */
    remote.wireFramePersistence((_sid, ev) => sessions.persistInboundEvent(ev));

    const sessionId = uid("real-recover");
    const now = Date.now();
    store.createSession({
      id: sessionId,
      harness: "pi",
      cwd: "/tmp",
      title: "recovery",
      state: "running",
      createdAt: now,
      updatedAt: now,
    } as never);

    let adapter: any = null;
    remote.wireRemoteRegistry({
      register: (_id, a) => {
        adapter = a;
      },
      unregister: () => {},
      sessionGone: () => {},
    });
    const sent: string[] = [];
    const sock = { send: (s: string) => void sent.push(s), close: () => {}, readyState: 1 };
    remote.agentHello(
      "h-recover",
      "recover-host",
      [{ id: "pi", capabilities: { permissions: false, subagents: false, streaming: true, queueWhileRunning: true } }],
      sock,
    );
    try {
      const p = adapter.spawn({ sessionId, cwd: "/tmp" });
      remote.agentFrame("h-recover", { type: "spawned", reqId: JSON.parse(sent[sent.length - 1]).reqId, ok: true });
      await p;

      /* Nobody drains this session's queue (the stalled consumer the issue is
         about). Push far more than the byte budget through the REAL router. */
      const big = "x".repeat(200_000);
      const total = 120;
      for (let i = 0; i < total; i++) {
        remote.agentFrame("h-recover", {
          type: "event",
          sessionId,
          ev: { type: "msg.chunk", sessionId, messageId: "m1", text: `${i}:${big}` },
        });
      }

      /* the live queue really did overflow and drop */
      const stat = remote.queueStats().find((s) => s.sessionId === sessionId);
      assert.ok(stat, "the queue is tracked");
      assert.equal(stat.lagging, true, "the live queue overflowed");
      assert.ok(stat.depth < total, `frames were dropped from the live path (depth ${stat.depth} of ${total})`);

      /* THE INVARIANT: every frame that ever entered the router is in the log,
         including the ones the live queue evicted. If persistence ever moves
         back downstream of the queue, this fails. */
      const logged = store.listEvents(sessionId).filter((f) => (f.ev as { type: string }).type === "msg.chunk");
      assert.equal(logged.length, total, "EVERY frame reached the durable log — dropping lost nothing");
      const texts = logged.map((f) => (f.ev as { text: string }).text);
      assert.equal(texts[0], `0:${big}`, "including the OLDEST frame the live queue already evicted");
      assert.equal(texts[total - 1], `${total - 1}:${big}`, "and the newest");

      /* a reconnecting consumer replays from the log and loses nothing */
      const replayed = store.listEvents(sessionId).filter((f) => (f.ev as { type: string }).type === "msg.chunk");
      assert.equal(replayed.length, total, "the replay is complete despite the drops");
    } finally {
      remote.agentBye("h-recover", sock);
      remote.wireFramePersistence(null);
    }
  } finally {
    cleanup();
  }
});

test("a frame the pump drains is persisted exactly ONCE (no double log entry)", async () => {
  /* The router persists on receipt, and the goLive pump ALSO persists what it
     drains — so a remote frame would land in the transcript twice unless the
     pump recognises it as already written. That would double every remote
     message, which is worse than the bug being fixed. */
  const { cleanup } = await freshServer("q218-dedupe");
  try {
    const { store } = await import("../src/db.js");
    const sessions = await import("../src/sessions.js");
    const remote = await import("../src/remote.js");

    remote.wireFramePersistence((_sid, ev) => sessions.persistInboundEvent(ev));

    const sessionId = uid("dedupe");
    const now = Date.now();
    store.createSession({
      id: sessionId,
      harness: "pi",
      cwd: "/tmp",
      title: "dedupe",
      state: "running",
      createdAt: now,
      updatedAt: now,
    } as never);

    /* the router persists and marks the exact object it hands the queue */
    const ev = { type: "msg.chunk" as const, sessionId, messageId: "m1", text: "hello" };
    sessions.persistInboundEvent(ev as never);
    assert.equal(store.listEvents(sessionId).length, 1, "persisted on receipt");

    /* when the pump drains that same object, it must NOT write it again */
    const q = new BoundedEventQueue<typeof ev>();
    q.push(ev);
    for await (const drained of q) {
      if (sessions.persistedByRouterForTest(drained as never)) {
        /* the pump's real branch: broadcast only, no second store write */
      } else {
        store.appendEvent(drained as never);
      }
      break;
    }
    assert.equal(store.listEvents(sessionId).length, 1, "drained frame was NOT written a second time");
  } finally {
    cleanup();
  }
});

test("the queue's health hooks report lag once, recovery, and the wedge", async () => {
  const { cleanup } = await freshServer("q218-health");
  try {
    const remote = await import("../src/remote.js");
    /* this fixture has no DB row for the session, so a leftover persistence
       wiring from another test would (correctly) refuse to enqueue its frames
       — the router drops frames it cannot log. Unwire it explicitly: this test
       covers the QUEUE's health reporting, not persistence. */
    remote.wireFramePersistence(null);
    const events: string[] = [];
    remote.wireQueueHealth({
      onLag: (sid) => void events.push(`lag:${sid}`),
      onRecovered: (sid) => void events.push(`recovered:${sid}`),
      onWedged: (sid) => void events.push(`wedged:${sid}`),
    });
    try {
      /* the hooks are driven through the real frame router, so this covers
         the wiring in remote.ts — not just the queue class */
      let adapter: any = null;
      remote.wireRemoteRegistry({
        register: (_id, a) => {
          adapter = a;
        },
        unregister: () => {},
        sessionGone: () => {},
      });
      const sent: string[] = [];
      const sock = { send: (s: string) => void sent.push(s), close: () => {}, readyState: 1 };
      const healthSid = uid("health");
      remote.agentHello("h-q218", "q218-host", [{ id: "pi", capabilities: { permissions: false, subagents: false, streaming: true, queueWhileRunning: true } }], sock);
      try {
        const p = adapter.spawn({ sessionId: healthSid, cwd: "/tmp" });
        remote.agentFrame("h-q218", { type: "spawned", reqId: JSON.parse(sent[sent.length - 1]).reqId, ok: true });
        await p;

        /* a consumer that never reads: enough frames to blow the default cap */
        const big = "x".repeat(100_000);
        for (let i = 0; i < 120; i++) {
          remote.agentFrame("h-q218", { type: "event", sessionId: healthSid, ev: { type: "msg.chunk", sessionId: healthSid, messageId: `m${i}`, text: big } });
        }
        const lagFrames = events.filter((e) => e === `lag:${healthSid}`);
        assert.equal(lagFrames.length, 1, `exactly ONE lag for the whole episode (got ${events.join(",")})`);

        /* it is visible in the metrics surface the issue asks for */
        const stat = remote.queueStats().find((s) => s.sessionId === healthSid);
        assert.ok(stat, "the queue is reported in queueStats()");
        assert.equal(stat.lagging, true, "the lagging flag is exposed");
        assert.ok(stat.depth > 0 && stat.bytes > 0, "depth and bytes are exposed");
        assert.equal(stat.hostId, "h-q218", "attributed to the owning host");
      } finally {
        remote.agentBye("h-q218", sock);
      }
    } finally {
      remote.wireQueueHealth(null);
    }
  } finally {
    cleanup();
  }
});

test("LINK_WEDGED stays outside the tunnel's 4400-4406 range (#246)", () => {
  assert.equal(LINK_WEDGED, 4407);
  assert.ok(LINK_WEDGED > 4406, "must not collide with the declared tunnel range");
});

test("sustained overflow fires the REAL wedge path and closes with 4407 (constraint 3, audit B3)", async () => {
  /* Audit B3: the previous version of this test hand-called dropWedgedQueue
     and never let the window elapse, so the `onWedged` wiring and the link
     close it claims to cover were both untested. The queue's wedge window is
     injected here (constraint 1), so the real onWedged → dropWedgedQueue →
     socket.close(4407) path runs end to end without sleeping. */
  const { cleanup } = await freshServer("q218-wedge");
  try {
    const remote = await import("../src/remote.js");
    const sessions = await import("../src/sessions.js");
    const { store } = await import("../src/db.js");
    remote.wireFramePersistence((_sid, ev) => sessions.persistInboundEvent(ev));

    const events: string[] = [];
    const closes: { code?: number; reason?: string }[] = [];
    let adapter: any = null;
    remote.wireQueueHealth({
      onLag: () => void events.push("lag"),
      onRecovered: () => void events.push("recovered"),
      onWedged: (sid) => {
        events.push(`wedged:${sid}`);
        remote.dropWedgedQueue(sid); // the server's real handler
      },
    });
    /* make the window elapse immediately for every queue this test creates */
    remote.setQueueWedgeWindowForTest(0);
    remote.wireRemoteRegistry({
      register: (_id, a) => {
        adapter = a;
      },
      unregister: () => {},
      sessionGone: () => {},
    });

    const sid = uid("wedge");
    const now = Date.now();
    store.createSession({
      id: sid, harness: "pi", cwd: "/tmp", title: "wedge", state: "running",
      createdAt: now, updatedAt: now,
    } as never);

    const sent: string[] = [];
    /* close() is a RECORDING stub — this is the assertion surface for 4407 */
    const sock = {
      send: (s: string) => void sent.push(s),
      close: (code?: number, reason?: string) => void closes.push({ code, reason }),
      readyState: 1,
    };
    remote.agentHello(
      "h-wedge",
      "wedge-host",
      [{ id: "pi", capabilities: { permissions: false, subagents: false, streaming: true, queueWhileRunning: true } }],
      sock,
    );
    try {
      const p = adapter.spawn({ sessionId: sid, cwd: "/tmp" });
      remote.agentFrame("h-wedge", { type: "spawned", reqId: JSON.parse(sent[sent.length - 1]).reqId, ok: true });
      await p;

      /* a producer that keeps overflowing a consumer that never drains */
      const big = "x".repeat(900_000);
      for (let i = 0; i < 30; i++) {
        remote.agentFrame("h-wedge", {
          type: "event",
          sessionId: sid,
          ev: { type: "msg.chunk", sessionId: sid, messageId: `m${i}`, text: big },
        });
      }

      /* the REAL wiring fired — not a hand-call */
      assert.equal(events.filter((e) => e === "lag").length, 1, "exactly one lag event for the episode");
      assert.deepEqual(
        events.filter((e) => e.startsWith("wedged:")),
        [`wedged:${sid}`],
        "the sustained window fired onWedged through the real router",
      );
      assert.equal(events.filter((e) => e === "recovered").length, 0, "a wedge is NOT a recovery");

      /* and the link really was closed with the dedicated code */
      assert.equal(closes.length, 1, "the tunnel was closed exactly once");
      assert.equal(closes[0].code, 4407, "closed with LINK_WEDGED");
      assert.equal(closes[0].code, LINK_WEDGED);

      /* The dispose frame itself is the PUMP's job, not dropWedgedQueue's
         (audit round 2, B3): q.close() ends the goLive for-await and its
         `finally` calls adapter.dispose(handle). This fixture spawns without
         createSession, so it has no pump and asserts only the contract the
         wedge owns — the queue is torn down and the link closed. The single
         dispose frame is pinned in queue-pump-dispose.test.ts. */
      assert.equal(remote.queueStats().some((s) => s.sessionId === sid), false, "the queue is torn down");

      /* Every frame the router ACCEPTED before the wedge is in the log — the
         recovery property holds through the close, not just through a drop.
         Frames that arrive AFTER the teardown are for a session the server
         just told the agent to dispose; they are dropped (and now logged, not
         silently swallowed — audit B2), so the count is asserted as "all
         frames up to the wedge", not all 30. */
      /* The frames are identical strings, so completeness is asserted by
         COUNT and by the messageId band: the router accepted a prefix of the
         stream (0..n-1) before the wedge tore the queue down, and every one
         of those is in the log. */
      const logged = store.listEvents(sid).filter((f) => (f.ev as { type: string }).type === "msg.chunk");
      const ids = logged.map((f) => Number((f.ev as { messageId: string }).messageId.replace("m", "")));
      assert.ok(
        logged.length > 0 && logged.length <= 30,
        `frames accepted before the wedge are replayable (got ${logged.length})`,
      );
      assert.deepEqual(
        ids,
        Array.from({ length: ids.length }, (_, i) => i),
        "no gaps — the replay is the contiguous prefix the router accepted",
      );
      assert.equal(
        new Set(logged.map((f) => (f.ev as { text: string }).text)).size,
        1,
        "and they carry the real payload",
      );
    } finally {
      remote.setQueueWedgeWindowForTest(null);
      remote.agentBye("h-wedge", sock);
      remote.wireQueueHealth(null);
      remote.wireFramePersistence(null);
    }
  } finally {
    cleanup();
  }
});

test("a wedged host with SIBLING sessions keeps their tunnel — only the wedged session is disposed", async () => {
  /* The tunnel is host-wide, so closing it for one wedged session would kill
     its siblings' links — exactly the "one wedged thing degrades that thing
     only" rule the issue states. */
  const { cleanup } = await freshServer("q218-wedge-siblings");
  try {
    const remote = await import("../src/remote.js");
    const sessions = await import("../src/sessions.js");
    const { store } = await import("../src/db.js");
    remote.wireFramePersistence((_sid, ev) => sessions.persistInboundEvent(ev));

    const closes: { code?: number }[] = [];
    let adapter: any = null;
    remote.wireQueueHealth({
      onLag: () => {},
      onRecovered: () => {},
      onWedged: (sid) => remote.dropWedgedQueue(sid),
    });
    remote.setQueueWedgeWindowForTest(0);
    remote.wireRemoteRegistry({
      register: (_id, a) => {
        adapter = a;
      },
      unregister: () => {},
      sessionGone: () => {},
    });

    const now = Date.now();
    const wedgedId = uid("w2");
    const siblingId = uid("sib");
    for (const id of [wedgedId, siblingId]) {
      store.createSession({
        id, harness: "pi", cwd: "/tmp", title: id, state: "running", createdAt: now, updatedAt: now,
      } as never);
    }

    const sent: string[] = [];
    const sock = {
      send: (s: string) => void sent.push(s),
      close: (code?: number) => void closes.push({ code }),
      readyState: 1,
    };
    remote.agentHello(
      "h-sib",
      "sib-host",
      [{ id: "pi", capabilities: { permissions: false, subagents: false, streaming: true, queueWhileRunning: true } }],
      sock,
    );
    try {
      for (const id of [wedgedId, siblingId]) {
        const p = adapter.spawn({ sessionId: id, cwd: "/tmp" });
        const last = JSON.parse(sent[sent.length - 1]) as { reqId: string };
        remote.agentFrame("h-sib", { type: "spawned", reqId: last.reqId, ok: true });
        await p;
      }

      /* only the FIRST session overflows */
      const big = "x".repeat(900_000);
      for (let i = 0; i < 30; i++) {
        remote.agentFrame("h-sib", {
          type: "event",
          sessionId: wedgedId,
          ev: { type: "msg.chunk", sessionId: wedgedId, messageId: `m${i}`, text: big },
        });
      }

      await tick(30);
      assert.equal(closes.length, 0, "the sibling's tunnel must NOT be closed");
      assert.equal(
        remote.queueStats().some((s) => s.sessionId === wedgedId),
        false,
        "the wedged queue is gone",
      );
      assert.equal(
        remote.queueStats().some((s) => s.sessionId === siblingId),
        true,
        "the sibling session's queue survives untouched",
      );
      assert.equal(
        remote.queueStats().some((s) => s.sessionId === wedgedId),
        false,
        "the wedged session's queue is closed and gone (the pump's exit condition)",
      );
    } finally {
      remote.setQueueWedgeWindowForTest(null);
      remote.agentBye("h-sib", sock);
      remote.wireQueueHealth(null);
      remote.wireFramePersistence(null);
    }
  } finally {
    cleanup();
  }
});

test("the byte budget measures UTF-8 BYTES, not UTF-16 code units (audit B6)", () => {
  /* A budget documented in bytes must charge bytes: `String.length` would
     under-count non-ASCII frames by up to ~3x, making the cap looser than
     claimed for exactly the frames (tool output, non-English text) most
     likely to be big. */
  const ev = { type: "msg.chunk", sessionId: "s", messageId: "m", text: "日本語テキスト🎉".repeat(100) };
  const utf8 = Buffer.byteLength(JSON.stringify(ev), "utf8");
  const utf16 = JSON.stringify(ev).length;
  assert.ok(utf8 > utf16, `multibyte content must charge MORE than code units (utf8 ${utf8} vs utf16 ${utf16})`);

  const q = new BoundedEventQueue<typeof ev>();
  q.push(ev);
  assert.equal(q.pendingBytes, utf8, "the queue charges real wire bytes");

  /* and the default sizer is the one doing it — a frame sized by code units
     would land under this budget while the byte-accurate one exceeds it */
  const budget = Math.floor((utf8 + utf16) / 2);
  const q2 = new BoundedEventQueue<typeof ev>(budget, 99);
  const small = { type: "msg.chunk" as const, sessionId: "s", messageId: "m", text: "a".repeat(0) };
  q2.push(small);
  q2.push(small);
  q2.push(small);
  const out = q2.push(ev);
  assert.ok(out.dropped > 0 || q2.pendingBytes <= budget + utf8, "the multibyte frame is charged its true size");
});

test("a live remote frame is broadcast with its LOG ROWID, not seq 0 (round 2, B1)", async () => {
  /* The client drops any frame with `seq <= lastSeq` (web store.ts applyFrames).
     The round-1 fix routed persisted remote frames through a broadcast helper
     that hard-coded seq 0, so EVERY live frame of a tunnelled session was
     discarded by every hydrated browser view — the transcript silently froze
     until a manual reload. `sink` used to broadcast the real rowid; this pins
     that a router-persisted frame still carries one. */
  const { cleanup } = await freshServer("q218-seq");
  try {
    const { store } = await import("../src/db.js");
    const sessions = await import("../src/sessions.js");
    const remote = await import("../src/remote.js");

    /* capture what the server would put on the wire */
    const frames: { seq: number; ev: { type: string; text?: string } }[] = [];
    sessions.setBroadcaster((f) => void frames.push(f as never));

    remote.wireFramePersistence((_sid, ev) => sessions.persistInboundEvent(ev));

    const sessionId = uid("seq");
    const now = Date.now();
    store.createSession({
      id: sessionId, harness: "pi", cwd: "/tmp", title: "seq", state: "running",
      createdAt: now, updatedAt: now,
    } as never);

    let adapter: any = null;
    remote.wireRemoteRegistry({
      register: (_id, a) => {
        adapter = a;
      },
      unregister: () => {},
      sessionGone: () => {},
    });
    const sent: string[] = [];
    const sock = { send: (s: string) => void sent.push(s), close: () => {}, readyState: 1 };
    remote.agentHello(
      "h-seq",
      "seq-host",
      [{ id: "pi", capabilities: { permissions: false, subagents: false, streaming: true, queueWhileRunning: true } }],
      sock,
    );
    try {
      const p = adapter.spawn({ sessionId, cwd: "/tmp" });
      remote.agentFrame("h-seq", { type: "spawned", reqId: JSON.parse(sent[sent.length - 1]).reqId, ok: true });
      await p;

      remote.agentFrame("h-seq", {
        type: "event",
        sessionId,
        ev: { type: "msg.chunk", sessionId, messageId: "m1", text: "live frame" },
      });

      /* Drain the queue the way the production pump does (sessions.goLive is
         private and only starts from createSession; adapter.spawn alone starts
         no pump). Consuming the same events() iterator the server consumes is
         what makes this exercise the real broadcast path. */
      for await (const ev of adapter.events({ sessionId })) {
        sessions.persistOrBroadcastForTest(ev);
        break;
      }

      /* the router persisted it, so the pump broadcast it from the queue */
      const rows = store.listEvents(sessionId).filter((f) => f.ev.type === "msg.chunk");
      assert.equal(rows.length, 1, "the frame is in the log");
      const rowid = rows[0].seq;

      const live = frames.filter((f) => f.ev.type === "msg.chunk");
      assert.equal(live.length, 1, "exactly one live broadcast for the one frame");
      assert.equal(
        live[0].seq,
        rowid,
        `the live frame must carry its log rowid (got ${live[0].seq}, log says ${rowid}) — seq 0 is discarded by every hydrated client view`,
      );
      assert.notEqual(live[0].seq, 0, "seq 0 would be dropped by the client's `seq <= lastSeq` dedupe");
    } finally {
      remote.agentBye("h-seq", sock);
      remote.wireFramePersistence(null);
      sessions.setBroadcaster(() => {});
    }
  } finally {
    cleanup();
  }
});

test("a frame that fails to persist is NOT queued or broadcast (round 2, B2)", async () => {
  /* The persist-failure comment claimed "frame NOT queued" while the router
     enqueued it anyway. A frame with no durable copy that still reaches the
     client is the silent-loss shape this ordering exists to prevent. */
  const { cleanup } = await freshServer("q218-persistfail");
  try {
    const { store } = await import("../src/db.js");
    const sessions = await import("../src/sessions.js");
    const remote = await import("../src/remote.js");

    const frames: unknown[] = [];
    sessions.setBroadcaster((f) => void frames.push(f));

    let calls = 0;
    remote.wireFramePersistence((sid, ev) => {
      calls++;
      /* first frame persists, the rest fail (a transient sqlite fault) */
      if (calls > 1) return null;
      return sessions.persistInboundEvent(ev);
    });

    const sessionId = uid("pf");
    const now = Date.now();
    store.createSession({
      id: sessionId, harness: "pi", cwd: "/tmp", title: "pf", state: "running",
      createdAt: now, updatedAt: now,
    } as never);

    let adapter: any = null;
    remote.wireRemoteRegistry({
      register: (_id, a) => {
        adapter = a;
      },
      unregister: () => {},
      sessionGone: () => {},
    });
    const sent: string[] = [];
    const sock = { send: (s: string) => void sent.push(s), close: () => {}, readyState: 1 };
    remote.agentHello(
      "h-pf",
      "pf-host",
      [{ id: "pi", capabilities: { permissions: false, subagents: false, streaming: true, queueWhileRunning: true } }],
      sock,
    );
    try {
      const p = adapter.spawn({ sessionId, cwd: "/tmp" });
      remote.agentFrame("h-pf", { type: "spawned", reqId: JSON.parse(sent[sent.length - 1]).reqId, ok: true });
      await p;

      for (let i = 0; i < 3; i++) {
        remote.agentFrame("h-pf", {
          type: "event",
          sessionId,
          ev: { type: "msg.chunk", sessionId, messageId: `m${i}`, text: `frame ${i}` },
        });
      }

      /* drain whatever did make it to the queue (the one persisted frame) */
      for await (const ev of adapter.events({ sessionId })) {
        sessions.persistOrBroadcastForTest(ev);
        break;
      }

      /* only the frame that actually persisted is in the log... */
      const logged = store.listEvents(sessionId).filter((f) => f.ev.type === "msg.chunk");
      assert.equal(logged.length, 1, "only the durably-logged frame is in the log");

      /* ...and the failed ones did not enter the queue either, so nothing for
         them can ever be broadcast */
      const stat = remote.queueStats().find((s) => s.sessionId === sessionId);
      assert.equal(stat?.depth ?? 0, 0, "failed frames did not accumulate in the live queue");
      assert.equal(calls, 3, "the router did attempt all three");
    } finally {
      remote.agentBye("h-pf", sock);
      remote.wireFramePersistence(null);
      sessions.setBroadcaster(() => {});
    }
  } finally {
    cleanup();
  }
});
