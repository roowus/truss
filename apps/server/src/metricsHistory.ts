/* Rolling per-host metrics history for the Monitor tab. Extracted from
   index.ts so the ring's cap and dedupe are fixture-testable without
   booting fastify (audit round 3, B2). */

export interface HistPoint {
  t: number;
  cpu: number;
  mem: number;
  rx: number;
  tx: number;
}

/* 1200 × ~3s polls ≈ 60 minutes — the reference monitor's history depth
   (its own 2400 × 1.5s), so the Monitor tab can offer the same ranges.
   /api/metrics ships the ring whole each poll (~55 B/point ≈ 66 KB per host
   per 3s at the cap): accepted wire cost for client-side range switching,
   same family as the reference's own 2400-point payload. */
export const HISTORY_CAP = 1200;

/* polls faster than this collapse into the last point — the panel ticks at
   3s, and duplicate samples would halve the usable window */
export const HISTORY_MIN_GAP_MS = 2000;

/** one ring per key (local host + each agent id) */
export function createMetricsHistory() {
  const rings = new Map<string, HistPoint[]>();
  return {
    get(key: string): HistPoint[] {
      return rings.get(key) ?? [];
    },
    push(key: string, p: HistPoint): void {
      const ring = rings.get(key) ?? [];
      const last = ring[ring.length - 1];
      if (last && p.t - last.t < HISTORY_MIN_GAP_MS) return;
      ring.push(p);
      if (ring.length > HISTORY_CAP) ring.shift();
      rings.set(key, ring);
    },
  };
}

/** one snapshot → its history point (defensive against older agents that
    lack whole sections) */
export function histPointOf(m: any): HistPoint {
  return {
    t: m.at,
    cpu: m.cpu?.usage ?? 0,
    mem: m.mem?.total ? (m.mem.used / m.mem.total) * 100 : 0,
    rx: (m.net ?? []).reduce((a: number, n: any) => a + (n.rxBps || 0), 0),
    tx: (m.net ?? []).reduce((a: number, n: any) => a + (n.txBps || 0), 0),
  };
}
