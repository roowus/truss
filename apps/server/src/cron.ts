/**
 * cron.ts — a pure 5-field cron engine (issue #16).
 *
 *   nextCronRun(expr, fromMs) → number | null
 *
 * Standard 5-field cron (minute hour day-of-month month day-of-week) with
 * `*` `?` `,` `-` and `/step`; DOW 0 and 7 are both Sunday. Semantics are
 * Vixie/POSIX: when BOTH day-of-month and day-of-week are restricted, a day
 * runs when EITHER matches (the "friday the 13th" rule); when only one is
 * restricted it alone gates the day. Schedules evaluate in the HOST'S LOCAL
 * time — the user means "9am" on the box the server runs on. The result is
 * strictly AFTER fromMs and exact to the minute. Invalid expressions (and
 * expressions that never fire within the search cap) return null — the
 * engine never throws, so it is safe to call on raw user input.
 */

interface Field {
  /** index = field value; for day-of-week, 7 is folded into 0 (Sunday) */
  values: boolean[];
  /** false only for a lone `*`/`?` — drives the Vixie dom/dow OR rule */
  restricted: boolean;
}

export interface ParsedCron {
  minute: Field;
  hour: Field;
  dom: Field;
  month: Field;
  dow: Field;
}

const FIELDS = [
  { min: 0, max: 59, name: "minute" },
  { min: 0, max: 23, name: "hour" },
  { min: 1, max: 31, name: "day-of-month" },
  { min: 1, max: 12, name: "month" },
  { min: 0, max: 7, name: "day-of-week" },
] as const;

/* The widest legitimate gap is 8 years: Feb 29 after a century-skipped leap
   (2096 → 2104). Anything unfired past that (Feb 31, …) never runs. */
const SEARCH_CAP_DAYS = 366 * 8 + 2;

function parseField(text: string, min: number, max: number, name: string): Field | string {
  const values = new Array<boolean>(max + 1).fill(false);
  for (const item of text.split(",")) {
    if (!item) return `${name}: empty list item in ${JSON.stringify(text)}`;
    const slash = item.indexOf("/");
    const base = slash === -1 ? item : item.slice(0, slash);
    const stepText = slash === -1 ? null : item.slice(slash + 1);
    let step = 1;
    if (stepText !== null) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) {
        return `${name}: bad step ${JSON.stringify(stepText)} — need a number >= 1`;
      }
      step = Number(stepText);
    }
    let lo: number;
    let hi: number;
    if (base === "*" || base === "?") {
      lo = min;
      hi = max;
    } else if (/^\d+$/.test(base)) {
      lo = Number(base);
      /* Vixie: a stepped single value ("9/5") runs from the value to max */
      hi = stepText === null ? lo : max;
    } else {
      const m = /^(\d+)-(\d+)$/.exec(base);
      if (!m) return `${name}: cannot parse ${JSON.stringify(item)}`;
      lo = Number(m[1]);
      hi = Number(m[2]);
      if (lo > hi) return `${name}: range ${lo}-${hi} is reversed`;
    }
    if (lo < min || hi > max) {
      return `${name}: ${JSON.stringify(base)} is outside ${min}-${max}`;
    }
    for (let v = lo; v <= hi; v += step) values[name === "day-of-week" && v === 7 ? 0 : v] = true;
  }
  /* a field is unrestricted only when it is exactly `*` or `?` — a stepped
     star ("*‍/2") or a mixed list ("*,5") counts as restricted */
  return { values, restricted: text !== "*" && text !== "?" };
}

function parse(expr: string): { cron: ParsedCron; error: null } | { cron: null; error: string } {
  if (typeof expr !== "string") return { cron: null, error: "expression must be a string" };
  const trimmed = expr.trim();
  const parts = trimmed ? trimmed.split(/\s+/) : [];
  if (parts.length !== 5) {
    return {
      cron: null,
      error: `need 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`,
    };
  }
  const fields: Field[] = [];
  for (let i = 0; i < 5; i++) {
    const r = parseField(parts[i], FIELDS[i].min, FIELDS[i].max, FIELDS[i].name);
    if (typeof r === "string") return { cron: null, error: r };
    fields.push(r);
  }
  const [minute, hour, dom, month, dow] = fields;
  return { cron: { minute, hour, dom, month, dow }, error: null };
}

/** Parse, or null when invalid. */
export function parseCron(expr: string): ParsedCron | null {
  return parse(expr).cron;
}

/** Why an expression is invalid, or null when it parses — for input-time
    rejection with a useful message. */
export function cronSyntaxError(expr: string): string | null {
  return parse(expr).error;
}

function dayMatches(p: ParsedCron, d: Date): boolean {
  const domHit = p.dom.values[d.getDate()];
  const dowHit = p.dow.values[d.getDay()];
  if (p.dom.restricted && p.dow.restricted) return domHit || dowHit; // Vixie OR
  if (p.dom.restricted) return domHit;
  if (p.dow.restricted) return dowHit;
  return true;
}

function sortedValues(f: Field, max: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= max; i++) if (f.values[i]) out.push(i);
  return out;
}

export function nextCronRun(expr: string, fromMs: number): number | null {
  const p = parseCron(expr);
  if (!p || !Number.isFinite(fromMs)) return null;
  const hours = sortedValues(p.hour, 23);
  const minutes = sortedValues(p.minute, 59);

  /* strictly after fromMs at minute precision: the first candidate is the
     minute boundary after fromMs (an exactly-on-minute fromMs is the current
     slot, not "next") */
  const startMs = Math.floor(fromMs / 60_000) * 60_000 + 60_000;
  const start = new Date(startMs);
  const startH = start.getHours();
  const startM = start.getMinutes();

  const day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  for (let i = 0; i <= SEARCH_CAP_DAYS; i++) {
    if (p.month.values[day.getMonth() + 1] && dayMatches(p, day)) {
      const sameDay = i === 0;
      for (const h of hours) {
        if (sameDay && h < startH) continue;
        for (const m of minutes) {
          if (sameDay && h === startH && m < startM) continue;
          return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).getTime();
        }
      }
    }
    day.setDate(day.getDate() + 1); // calendar-safe across months/years/DST
  }
  return null;
}
