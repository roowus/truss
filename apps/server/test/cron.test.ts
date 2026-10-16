import { test } from "node:test";
import assert from "node:assert/strict";

/* SPEC-TESTS for cron jobs — https://github.com/roowus/truss/issues/16
   ("Cron jobs"). These FAIL on purpose today: they pin the contract a fix
   must satisfy. (The task board says it plainly — tasks.ts:10: "No
   cron/scheduling in v1".)

   The contract: a pure cron engine in src/cron.ts —

     nextCronRun(expr: string, fromMs: number): number | null

   Standard 5-field cron (minute hour day-of-month month day-of-week) with
   `*` `?` `,` `-` and `/step`; DOW 0 and 7 are both Sunday. Semantics are
   Vixie/POSIX: when BOTH day-of-month and day-of-week are restricted, a run
   happens when EITHER matches (the "friday the 13th" rule). Invalid
   expressions return null, never throw. The result is strictly AFTER fromMs
   and exact to the minute. Schedules evaluate in the HOST'S LOCAL time (the
   user means "9am" on the box they're looking at); fixtures below are built
   with local-time constructors, so the suite is green in any timezone.

   The scheduler loop (tasks gain a schedule, a tick spawns due runs through
   the existing task→session→prompt path) is acceptance criteria, not here. */

interface CronModule {
  nextCronRun(expr: string, fromMs: number): number | null;
}

async function load(): Promise<CronModule | null> {
  const spec = "../src/cron.js"; // variable specifier: typechecks even before the module exists
  return import(spec).catch(() => null);
}

/* 2026-01-07 is a Wednesday; all fixtures are HOST-LOCAL on purpose */
const WED = new Date(2026, 0, 7, 12, 0, 0).getTime();

test("src/cron.ts exists and parses step expressions", async () => {
  const cron = await load();
  assert.ok(cron, "src/cron.ts must export nextCronRun — see issue #16");
  assert.equal(cron.nextCronRun("*/15 * * * *", WED), new Date(2026, 0, 7, 12, 15).getTime(), "quarter-hour step");
});

test("strictly-after and minute precision", async () => {
  const cron = await load();
  assert.ok(cron, "cron module must exist (see module test)");
  const atMinute = new Date(2026, 0, 7, 12, 30, 0).getTime();
  assert.equal(cron.nextCronRun("30 12 * * *", atMinute), new Date(2026, 0, 8, 12, 30).getTime(), "the current minute's slot is not 'next'");
  assert.equal(cron.nextCronRun("31 12 * * *", atMinute), new Date(2026, 0, 7, 12, 31).getTime());
  assert.equal(cron.nextCronRun("* * * * *", atMinute + 30_000), new Date(2026, 0, 7, 12, 31).getTime(), "every-minute from mid-minute");
});

test("fixed weekday + time; DOW 0 and 7 are both Sunday", async () => {
  const cron = await load();
  assert.ok(cron, "cron module must exist (see module test)");
  assert.equal(cron.nextCronRun("0 9 * * 1", WED), new Date(2026, 0, 12, 9, 0).getTime(), "next Monday 09:00");
  const sunday = new Date(2026, 0, 11, 0, 0, 0).getTime();
  assert.equal(cron.nextCronRun("0 0 * * 0", WED), sunday);
  assert.equal(cron.nextCronRun("0 0 * * 7", WED), sunday, "7 is Sunday too");
});

test("lists, ranges, and day-of-month", async () => {
  const cron = await load();
  assert.ok(cron, "cron module must exist (see module test)");
  assert.equal(cron.nextCronRun("0 0 1,15 * *", new Date(2026, 0, 3).getTime()), new Date(2026, 0, 15).getTime(), "1st and 15th");
  assert.equal(cron.nextCronRun("0 9-17 * * *", new Date(2026, 0, 7, 8, 0).getTime()), new Date(2026, 0, 7, 9, 0).getTime(), "hour range");
  assert.equal(cron.nextCronRun("0 0 29 2 *", new Date(2025, 5, 1).getTime()), new Date(2028, 1, 29).getTime(), "Feb 29 waits for a leap year");
});

test("Vixie OR rule: restricted dom + dow matches EITHER (friday the 13th)", async () => {
  const cron = await load();
  assert.ok(cron, "cron module must exist (see module test)");
  /* from Mon 2026-01-05: the 13th is Tuesday, but Friday the 9th comes first
     under OR semantics (AND semantics would wait a week longer) */
  assert.equal(cron.nextCronRun("0 0 13 * 5", new Date(2026, 0, 5).getTime()), new Date(2026, 0, 9).getTime(), "dom=13 OR dow=fri — not AND");
});

test("invalid expressions return null, never throw", async () => {
  const cron = await load();
  assert.ok(cron, "cron module must exist (see module test)");
  for (const bad of ["", "bogus", "* * * *", "* * * * * *", "61 * * * *", "* 25 * * *", "0 0 32 * *", "0 0 * 13 *", "*/0 * * * *", "5-1 * * * *"]) {
    assert.equal(cron.nextCronRun(bad, WED), null, `${JSON.stringify(bad)} → null`);
  }
});
