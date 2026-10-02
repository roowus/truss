/**
 * Trajectory request timeline (issue #20): one chronological strip above the
 * calls table — shared time axis, overlaps stack into lanes, in-flight calls
 * grow live, click jumps to the row. Pure math lives here, DOM-free.
 */

export const TIMELINE_MIN_SPAN_MS = 1000; // the panel's existing clamp
export const TIMELINE_MIN_WIDTH_PCT = 0.6; // the panel's existing minimum sliver

export interface TimelineCall {
  callId: string;
  at: number;
  done: boolean;
  latencyMs?: number;
  status?: number;
  retryOf?: string;
}
export interface TimelineScale {
  t0: number;
  tEnd: number;
  spanMs: number;
}
export interface TimelineBar {
  callId: string;
  leftPct: number;
  widthPct: number;
  lane: number;
}

const endOf = (c: TimelineCall, now: number) => (c.done && c.latencyMs != null ? c.at + c.latencyMs : now);

/** the ONE error semantics, shared by the calls table and the timeline bars:
    a call is an error once finished with a status outside 2xx (an in-flight
    call is never red, whatever status it already carries) */
export const callIsError = (c: Pick<TimelineCall, "done" | "status">) =>
  c.done && c.status != null && (c.status < 200 || c.status >= 300);

/** first start → latest end (in-flight calls end at now, so the axis grows live) */
export function timelineScale(calls: TimelineCall[], now: number): TimelineScale | null {
  if (calls.length === 0) return null;
  const t0 = Math.min(...calls.map((c) => c.at));
  const tEnd = Math.max(...calls.map((c) => endOf(c, now)));
  return { t0, tEnd, spanMs: Math.max(tEnd - t0, TIMELINE_MIN_SPAN_MS) };
}

export function timelineBars(calls: TimelineCall[], scale: TimelineScale, now: number): TimelineBar[] {
  const { t0, spanMs } = scale;
  const sorted = [...calls].sort((a, b) => a.at - b.at || a.callId.localeCompare(b.callId));
  const laneEnds: number[] = [];
  return sorted.map((c) => {
    const start = c.at;
    const end = endOf(c, now);
    let leftPct = ((start - t0) / spanMs) * 100;
    leftPct = Math.min(Math.max(leftPct, 0), 100 - TIMELINE_MIN_WIDTH_PCT);
    const rawWidth = ((Math.max(end, start) - start) / spanMs) * 100;
    const widthPct = Math.min(Math.max(rawWidth, TIMELINE_MIN_WIDTH_PCT), 100 - leftPct);

    /* greedy lowest-free-lane: bars that overlap never share one; the lane
       count then equals max request concurrency (interval-graph property) */
    let lane = laneEnds.findIndex((le) => le <= start);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = Math.max(end, start);

    return { callId: c.callId, leftPct, widthPct, lane };
  });
}

export function timelineLanes(bars: TimelineBar[]): number {
  return bars.length === 0 ? 0 : Math.max(...bars.map((b) => b.lane)) + 1;
}

/* a human ladder — ticks read 1s → 5s → 30s → 1m → 5m → … */
const LADDER_MS = [1_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000];

export function rulerTicks(scale: TimelineScale, maxTicks: number): { t: number; pct: number }[] {
  const { t0, tEnd, spanMs } = scale;
  let step = LADDER_MS[LADDER_MS.length - 1];
  for (const s of LADDER_MS) {
    if (Math.floor(spanMs / s) + 1 <= maxTicks) {
      step = s;
      break;
    }
  }
  /* spans longer than the ladder top out at multiples of the top rung */
  if (Math.floor(spanMs / step) + 1 > maxTicks) {
    step = Math.ceil(spanMs / (maxTicks - 1) / LADDER_MS[LADDER_MS.length - 1]) * LADDER_MS[LADDER_MS.length - 1];
  }
  const out: { t: number; pct: number }[] = [];
  for (let t = t0; t <= tEnd; t += step) {
    out.push({ t, pct: ((t - t0) / spanMs) * 100 });
  }
  if (out.length === 1 && spanMs >= step) out.push({ t: t0 + step, pct: (step / spanMs) * 100 });
  return out;
}
