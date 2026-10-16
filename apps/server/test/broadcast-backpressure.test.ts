import { test } from "node:test";
import assert from "node:assert/strict";
import { BroadcastGuard, CLIENT_MAX_BUFFERED_BYTES } from "../src/broadcastGuard.js";
import { LINK_WEDGED } from "../src/remote.js";

/* issue #218, second path — the WS broadcast fan-out.

   A browser tab that stops reading must degrade THAT CLIENT ONLY: never the
   whole server, never another client. The guard closes the laggard with
   LINK_WEDGED once it has been over budget for the sustained window. All
   timing is injectable (constraint 1) — nothing here sleeps. */

function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

/** a ws-shaped stub whose bufferedAmount the test drives directly */
function fakeClient(buffered = 0) {
  const sent: string[] = [];
  const closes: { code?: number; reason?: string }[] = [];
  return {
    sent,
    closes,
    bufferedAmount: buffered,
    send: (s: string) => void sent.push(s),
    close: (code?: number, reason?: string) => void closes.push({ code, reason }),
  };
}

test("a healthy client receives every frame and is never closed", () => {
  const g = new BroadcastGuard({ now: fakeClock().now });
  const c = fakeClient(0);
  for (let i = 0; i < 20; i++) assert.equal(g.deliver(c, `frame ${i}`), "sent");
  assert.equal(c.sent.length, 20, "all frames delivered");
  assert.equal(c.closes.length, 0, "a healthy client is never closed");
});

test("a briefly over-budget client is TOLERATED — a burst is not a dead reader", () => {
  const clock = fakeClock();
  const g = new BroadcastGuard({ now: clock.now });
  const c = fakeClient(CLIENT_MAX_BUFFERED_BYTES + 1);

  /* over budget, but well inside the window: it still gets the frames */
  assert.equal(g.deliver(c, "a"), "sent");
  clock.advance(1_000);
  assert.equal(g.deliver(c, "b"), "sent");
  assert.equal(c.closes.length, 0, "a large replay burst must NOT close the client");

  /* it catches up — the episode ends, so no stale window carries over */
  c.bufferedAmount = 0;
  assert.equal(g.deliver(c, "c"), "sent");
  assert.equal(c.closes.length, 0);
});

test("a client over budget for the sustained window is closed with 4407", () => {
  const clock = fakeClock();
  const g = new BroadcastGuard({ now: clock.now, wedgeAfterMs: 60_000 });
  const c = fakeClient(CLIENT_MAX_BUFFERED_BYTES + 1);

  assert.equal(g.deliver(c, "a"), "sent", "the window starts now; still tolerated");
  clock.advance(59_000);
  assert.equal(g.deliver(c, "b"), "sent", "under the window");
  assert.equal(c.closes.length, 0);

  clock.advance(2_000);
  assert.equal(g.deliver(c, "c"), "closed", "the window elapsed — close the laggard");
  assert.equal(c.closes.length, 1, "closed exactly once");
  assert.equal(c.closes[0].code, LINK_WEDGED, "the dedicated close code");
  assert.equal(c.closes[0].code, 4407);

  /* and it stays closed — no further sends or double closes */
  assert.equal(g.deliver(c, "d"), "skipped");
  assert.equal(c.closes.length, 1, "never closed twice");
  assert.equal(c.sent.length, 2, "no frame is sent after the close");
});

test("ONE wedged client never affects the others (degrade that client only)", () => {
  const clock = fakeClock();
  const g = new BroadcastGuard({ now: clock.now, wedgeAfterMs: 60_000 });
  const wedged = fakeClient(CLIENT_MAX_BUFFERED_BYTES + 1);
  const healthyA = fakeClient(0);
  const healthyB = fakeClient(0);

  g.deliver(wedged, "1");
  g.deliver(healthyA, "1");
  g.deliver(healthyB, "1");

  clock.advance(61_000);
  const outcomes = [g.deliver(wedged, "2"), g.deliver(healthyA, "2"), g.deliver(healthyB, "2")];
  assert.deepEqual(outcomes, ["closed", "sent", "sent"], "only the laggard is closed");

  assert.equal(wedged.closes.length, 1, "the laggard is closed");
  assert.equal(healthyA.closes.length, 0, "healthy client untouched");
  assert.equal(healthyB.closes.length, 0, "healthy client untouched");
  assert.deepEqual(healthyA.sent, ["1", "2"], "healthy clients keep every frame");
  assert.deepEqual(healthyB.sent, ["1", "2"]);
});

test("a throwing send marks the client gone instead of killing the fan-out", () => {
  const g = new BroadcastGuard({ now: fakeClock().now });
  const dead = {
    bufferedAmount: 0,
    send: () => {
      throw new Error("socket gone");
    },
    close: () => {},
  };
  assert.equal(g.deliver(dead, "x"), "skipped", "a dead socket is dropped, not thrown through");
  /* and the guard forgets it so it can't accumulate state for a gone client */
  g.forget(dead);
  assert.equal(g.deliver(dead, "y"), "skipped");
});

test("stats() reports the fan-out's backpressure for /api/metrics", () => {
  const g = new BroadcastGuard({ now: fakeClock().now });
  const a = fakeClient(0);
  const b = fakeClient(CLIENT_MAX_BUFFERED_BYTES + 500);
  const c = fakeClient(1234);
  const stats = g.stats([a, b, c]);
  assert.equal(stats.clients, 3, "client count");
  assert.equal(stats.overBudget, 1, "one client is behind");
  assert.equal(stats.maxBuffered, CLIENT_MAX_BUFFERED_BYTES + 500, "worst buffered depth is visible");
});

test("a client with no bufferedAmount (a test stub / pre-ws shape) is treated as healthy", () => {
  const g = new BroadcastGuard({ now: fakeClock().now });
  const c = { send: () => {}, close: () => {} };
  for (let i = 0; i < 5; i++) assert.equal(g.deliver(c, "x"), "sent", "never closed without a readable depth");
});
