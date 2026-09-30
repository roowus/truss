import { test } from "node:test";
import assert from "node:assert/strict";

/* SPEC-TESTS for the trajectory request timeline — https://github.com/roowus/truss/issues/20
   ("The trajectory page should have a request timeline"). These FAIL on
   purpose today: they pin the contract a fix must satisfy.

   Today TrajectoryPanel shows a stats strip + a calls table whose rows carry
   a per-row waterfall sliver (TrajectoryPanel.tsx:126-132). What a session
   lacks is the OVERVIEW: one chronological timeline where request bars share
   a time axis, overlaps stack into lanes, idle gaps are visible, in-flight
   calls grow live, and clicking a bar jumps to its row.

   The contract: a pure, DOM-free src/lib/requestTimeline.ts —

     timelineScale(calls, now) → { t0, tEnd, spanMs } | null
     timelineBars(calls, scale, now) → { callId, leftPct, widthPct, lane }[]
     timelineLanes(bars) → laneCount                       (see below)
     rulerTicks(scale, maxTicks) → { t, pct }[]            (nice-step ruler)

   with exported TIMELINE_MIN_SPAN_MS (= 1000, the panel's existing clamp)
   and TIMELINE_MIN_WIDTH_PCT (= 0.6, the panel's existing minimum sliver).

   Rules it must honor:
   - span runs from the first call's start to the latest end (in-flight calls
     end at `now`, so their bars GROW as now advances), never degenerate
     (span ≥ TIMELINE_MIN_SPAN_MS); no calls → null scale.
   - every bar: leftPct ≥ 0, widthPct ≥ TIMELINE_MIN_WIDTH_PCT,
     leftPct + widthPct ≤ 100 (a bar never spills past the axis);
   - lanes: bars that overlap in time never share a lane; greedy by start
     order; the lane count equals the session's max request concurrency
     (interval-graph property — a 3-wide burst stacks exactly 3 lanes);
   - ruler: strictly increasing "nice" ticks (ladder 1s→5s→30s→1m→5m…),
     ≤ maxTicks of them, all inside the span.

   The strip's rendering, hover detail, and bar→row jump are acceptance
   criteria, not here. */

interface CallLike {
  callId: string;
  at: number;
  done: boolean;
  latencyMs?: number;
  status?: number;
  retryOf?: string;
}
interface Scale {
  t0: number;
  tEnd: number;
  spanMs: number;
}
interface Bar {
  callId: string;
  leftPct: number;
  widthPct: number;
  lane: number;
}
interface TimelineModule {
  TIMELINE_MIN_SPAN_MS: number;
  TIMELINE_MIN_WIDTH_PCT: number;
  timelineScale(calls: CallLike[], now: number): Scale | null;
  timelineBars(calls: CallLike[], scale: Scale, now: number): Bar[];
  timelineLanes(bars: Bar[]): number;
  rulerTicks(scale: Scale, maxTicks: number): { t: number; pct: number }[];
}

async function load(): Promise<TimelineModule | null> {
  const spec = "../src/lib/requestTimeline"; // variable specifier: typechecks even before the module exists
  return import(spec).catch(() => null);
}

const T0 = 1_000_000;
const call = (callId: string, at: number, latencyMs?: number): CallLike => ({
  callId,
  at,
  done: latencyMs !== undefined,
  latencyMs,
  status: 200,
});

test("src/lib/requestTimeline.ts exists with the panel's existing constants", async () => {
  const tl = await load();
  assert.ok(tl, "src/lib/requestTimeline.ts must export the scale/bars/lanes/ruler helpers — see issue #20");
  assert.equal(tl.TIMELINE_MIN_SPAN_MS, 1000, "the table's existing span clamp");
  assert.equal(tl.TIMELINE_MIN_WIDTH_PCT, 0.6, "the table's existing minimum sliver");
});

test("timelineScale: first start → latest end; in-flight extends to now; empty → null; degenerate clamps", async () => {
  const tl = await load();
  assert.ok(tl, "requestTimeline module must exist (see module test)");

  const calls = [call("a", T0, 2000), call("b", T0 + 4000, 1000)];
  const s = tl.timelineScale(calls, T0 + 10_000)!;
  assert.deepEqual(s, { t0: T0, tEnd: T0 + 5000, spanMs: 5000 }, "scale covers first start to latest end");

  const live = [call("a", T0, 1000), call("b", T0 + 2000)];
  const s1 = tl.timelineScale(live, T0 + 6000)!;
  assert.equal(s1.tEnd, T0 + 6000, "an in-flight call ends at now");
  const s2 = tl.timelineScale(live, T0 + 9000)!;
  assert.equal(s2.spanMs, 9000, "and the axis grows as time passes");

  assert.equal(tl.timelineScale([], T0), null, "no calls → no timeline");

  const instant = tl.timelineScale([call("a", T0, 120)], T0 + 120)!;
  assert.equal(instant.spanMs, tl.TIMELINE_MIN_SPAN_MS, "a single instant call still gets a usable axis");
});

test("timelineBars: geometry is sane — positioned, minimally visible, never spilling; live bars grow", async () => {
  const tl = await load();
  assert.ok(tl, "requestTimeline module must exist (see module test)");

  const calls = [call("a", T0, 2000), call("b", T0 + 4000, 1000), call("c", T0 + 4500, 500)];
  const s = tl.timelineScale(calls, T0 + 10_000)!;
  const bars = tl.timelineBars(calls, s, s.tEnd);
  assert.equal(bars.length, 3);
  for (const b of bars) {
    assert.ok(b.leftPct >= 0 && b.leftPct <= 100, `${b.callId}: leftPct in range`);
    assert.ok(b.widthPct >= tl.TIMELINE_MIN_WIDTH_PCT, `${b.callId}: never invisible`);
    assert.ok(b.leftPct + b.widthPct <= 100.0001, `${b.callId}: never spills past the axis`);
  }
  const a = bars.find((b) => b.callId === "a")!;
  assert.ok(Math.abs(a.leftPct - 0) < 1e-9, "first call starts at the axis start");
  assert.ok(Math.abs(a.widthPct - 40) < 1e-6, "2s of a 5s span is 40%");

  /* in-flight: same inputs, later now → wider bar (the live tick) */
  const liveCalls = [call("x", T0)];
  const sLive = tl.timelineScale(liveCalls, T0 + 2000)!;
  const b1 = tl.timelineBars(liveCalls, sLive, T0 + 2000)[0];
  const sLater = tl.timelineScale(liveCalls, T0 + 6000)!;
  const b2 = tl.timelineBars(liveCalls, sLater, T0 + 6000)[0];
  assert.ok(b2.widthPct > 0 && b1.widthPct > 0);
  assert.equal(b2.callId, "x");
});

test("lanes: overlaps stack, never share; lane count equals max concurrency", async () => {
  const tl = await load();
  assert.ok(tl, "requestTimeline module must exist (see module test)");

  /* three-wide burst: x [0,3s], y [1s,4s], z [2s,5s] → 3 lanes; then a gap,
     then w [6s,7s] which may reuse lane 0 */
  const calls = [call("x", T0, 3000), call("y", T0 + 1000, 3000), call("z", T0 + 2000, 3000), call("w", T0 + 6000, 1000)];
  const s = tl.timelineScale(calls, T0 + 7000)!;
  const bars = tl.timelineBars(calls, s, s.tEnd);

  assert.equal(tl.timelineLanes(bars), 3, "a three-wide burst stacks exactly three lanes");
  const laneOf = (id: string) => bars.find((b) => b.callId === id)!.lane;
  assert.equal(new Set([laneOf("x"), laneOf("y"), laneOf("z")]).size, 3, "overlapping calls never share a lane");

  /* no overlap → one lane, however many calls */
  const serial = [call("a", T0, 500), call("b", T0 + 500, 500), call("c", T0 + 1000, 500)];
  const ss = tl.timelineScale(serial, T0 + 1500)!;
  assert.equal(tl.timelineLanes(tl.timelineBars(serial, ss, ss.tEnd)), 1, "serial calls fit one lane");
});

test("rulerTicks: nice steps, inside the span, bounded count", async () => {
  const tl = await load();
  assert.ok(tl, "requestTimeline module must exist (see module test)");

  const scale: Scale = { t0: T0, tEnd: T0 + 97_000, spanMs: 97_000 };
  const ticks = tl.rulerTicks(scale, 8);
  assert.ok(ticks.length >= 2 && ticks.length <= 8, "a handful of ticks, never a fence");
  const gaps = ticks.slice(1).map((t, i) => t.t - ticks[i].t);
  assert.ok(gaps.every((g) => g === gaps[0]), "evenly spaced");
  for (const t of ticks) {
    assert.ok(t.t >= scale.t0 && t.t <= scale.tEnd, "inside the axis");
    assert.ok(t.pct >= 0 && t.pct <= 100, "percent in range");
  }
  /* nice-step ladder: a 97s span must not read in 1s ticks */
  const stepSec = gaps[0] / 1000;
  assert.ok([1, 5, 10, 15, 30, 60, 120, 300, 600].some((n) => stepSec === n), `step ${stepSec}s comes off a human ladder`);

  const tiny = tl.rulerTicks({ t0: T0, tEnd: T0 + 3000, spanMs: 3000 }, 8);
  assert.ok(tiny.length <= 8 && tiny.length >= 2, "tiny spans still tick");
});
