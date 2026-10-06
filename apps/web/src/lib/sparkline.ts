/**
 * Sparkline math for the monitor's history graphs (issue #161): the y domain,
 * a few unit-labeled ticks, pointer snapping, and the hover tooltip text.
 * Pure functions so the tests can pin the contract without rendering.
 *
 * Values are REAL: percents are fractions of 1 (0.42 → "42%"), rates are
 * bytes per second formatted 1000-based ("182 kB/s" — kB is 1000 B here,
 * unlike fmtSize's 1024-based file sizes).
 */

export interface SparkTick {
  value: number;
  label: string;
}

export interface SparkScale {
  min: number;
  max: number;
  ticks: SparkTick[];
}

/** 1000-based rate formatting: "412 B/s", "182 kB/s", "1.2 MB/s". */
export function fmtRate(bps: number): string {
  if (!Number.isFinite(bps)) return "—";
  if (bps >= 1e9) return `${trim1(bps / 1e9)} GB/s`;
  if (bps >= 1e6) return `${trim1(bps / 1e6)} MB/s`;
  if (bps >= 1e3) return `${trim1(bps / 1e3)} kB/s`;
  return `${Math.round(bps)} B/s`;
}

/** One decimal at most, no trailing ".0": 182 → "182", 1.2 → "1.2". */
function trim1(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** A fraction of 1 as a percent label: 0.42 → "42%", 1 → "100%". */
function fmtPct(fraction: number): string {
  if (!Number.isFinite(fraction)) return "—";
  return `${trim1(fraction * 100)}%`;
}

/** The value with its unit, as shown on ticks and the live readout. */
export function sparkValueLabel(value: number, unit: string): string {
  if (unit === "%") return fmtPct(value);
  if (unit === "B/s") return fmtRate(value);
  return `${value} ${unit}`;
}

/** Step from the {1, 2, 5} × 10^k ladder near `raw` — keeps tick labels round. */
function niceStep(raw: number): number {
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return nice * mag;
}

/**
 * The y domain plus 2–4 unit-labeled ticks for a sparkline.
 * A pinned `domain` wins verbatim (percent: [0, 1]); otherwise the data's
 * min..max padded 10% for headroom (the peak never kisses the top), clamped
 * at zero when the data can't go negative. A flat series still gets a sane
 * non-zero span — the plot divides by it.
 */
export function sparkScale(points: number[], opts: { domain?: [number, number]; unit: string }): SparkScale {
  let lo: number, hi: number;
  if (opts.domain) {
    [lo, hi] = opts.domain;
  } else {
    const finite = points.filter((p) => Number.isFinite(p));
    const dmin = finite.length ? Math.min(...finite) : 0;
    const dmax = finite.length ? Math.max(...finite) : 0;
    if (dmax === dmin) {
      /* flat series: build a span around the value instead of dividing by zero */
      if (dmin === 0) { lo = 0; hi = 1; }
      else { const half = Math.abs(dmin) / 2; lo = dmin - half; hi = dmin + half; }
    } else {
      const pad = (dmax - dmin) * 0.1;
      lo = dmin - pad;
      hi = dmax + pad;
      if (dmin >= 0 && lo < 0) lo = 0;
    }
  }
  if (!(hi > lo)) hi = lo + 1;
  const step = niceStep((hi - lo) / 3);
  const ticks: SparkTick[] = [];
  for (let k = Math.ceil(lo / step); k <= Math.floor(hi / step); k++) {
    const v = k * step;
    ticks.push({ value: v, label: sparkValueLabel(v, opts.unit) });
  }
  if (ticks.length === 0) {
    ticks.push({ value: lo, label: sparkValueLabel(lo, opts.unit) }, { value: hi, label: sparkValueLabel(hi, opts.unit) });
  }
  return { min: lo, max: hi, ticks };
}

/**
 * Pointer x as a fraction of the plot width (0..1) → the NEAREST data
 * index, clamped to the ends. Empty series → -1 (no point to hover).
 */
export function sparkHoverIndex(length: number, xFraction: number): number {
  if (length <= 0) return -1;
  if (length === 1) return 0;
  const f = Number.isFinite(xFraction) ? Math.min(1, Math.max(0, xFraction)) : 0;
  return Math.min(length - 1, Math.max(0, Math.round(f * (length - 1))));
}

/** The tooltip line: the exact value with its unit, then when — "42% · 14:03". */
export function sparkPointLabel(point: number, opts: { at: number; unit: string }): string {
  return `${sparkValueLabel(point, opts.unit)} · ${fmtClock(opts.at)}`;
}

/* UTC clock (HH:MM): history ticks are epoch ms and the monitor compares
   hosts across machines — one clock for every viewer. */
function fmtClock(at: number): string {
  if (!Number.isFinite(at)) return "—";
  const d = new Date(at);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
