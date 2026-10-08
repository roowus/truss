import { test } from "node:test";
import assert from "node:assert/strict";
import {
  baseHarness,
  hostOf,
  harnessStyle,
  HARNESS,
  fmtMs,
  fmtTakeTime,
  fmtTokens,
  fmtCost,
  fmtUptime,
  ago,
  daysLeftInTrash,
  TRASH_RETENTION_DAYS,
  until,
  nextRunHint,
  fmtSize,
  shortPath,
  argSummary,
  procCell,
  deadSessionHint,
} from "../src/lib/format";

test("procCell: missing columns from a pre-upgrade node-agent render a dash, not a blank or NaN", () => {
  /* issue #10 added user/memPct/threads/ageSec; older agents and the demo
     fixture omit them — the Monitor table must stay readable */
  assert.equal(procCell(undefined), "—");
  assert.equal(procCell(null), "—");
  assert.equal(procCell(""), "—");
  assert.equal(procCell(0), "0", "zero is real data, not missing");
  assert.equal(procCell(3.5), "3.5");
  assert.equal(procCell("root"), "root");
});

test("baseHarness / hostOf split id@host", () => {
  assert.equal(baseHarness("pi"), "pi");
  assert.equal(baseHarness("pi@atlas"), "pi");
  assert.equal(baseHarness("claude-code@gpu-box"), "claude-code");
  assert.equal(hostOf("pi"), undefined);
  assert.equal(hostOf("pi@atlas"), "atlas");
});

test("harnessStyle: known harness (with/without host) and unknown fallback", () => {
  assert.equal(harnessStyle("pi"), HARNESS.pi);
  assert.equal(harnessStyle("pi@atlas"), HARNESS.pi); // styled by base harness
  assert.equal(harnessStyle("dsh").name, "DeepSeek Harness");
  const fb = harnessStyle("mystery");
  assert.deepEqual(fb, { name: "mystery", color: "#9aa3ad", glyph: "◇", blurb: "external harness" });
  // note: the fallback keeps the FULL id (including @host) as the display name
  assert.equal(harnessStyle("mystery@atlas").name, "mystery@atlas");
});

test("fmtMs: dash, sub-second, seconds, minute padding", () => {
  assert.equal(fmtMs(undefined), "—");
  assert.equal(fmtMs(null as unknown as number), "—");
  assert.equal(fmtMs(NaN), "—");
  assert.equal(fmtMs(0), "0ms");
  assert.equal(fmtMs(500), "500ms");
  assert.equal(fmtMs(999.4), "999ms");
  assert.equal(fmtMs(1000), "1.00s"); // <10s gets 2 decimals
  assert.equal(fmtMs(5500), "5.50s");
  assert.equal(fmtMs(15000), "15.0s"); // >=10s gets 1 decimal
  assert.equal(fmtMs(59999), "60.0s"); // quirk: rounds up to 60.0s instead of rolling into 1m00s
  assert.equal(fmtMs(60000), "1m00s"); // zero-padded seconds
  assert.equal(fmtMs(61000), "1m01s");
  assert.equal(fmtMs(90000), "1m30s");
  assert.equal(fmtMs(600000), "10m00s");
});

test("fmtTokens: dash, raw, k, M", () => {
  assert.equal(fmtTokens(undefined), "—");
  assert.equal(fmtTokens(0), "0");
  assert.equal(fmtTokens(999), "999");
  assert.equal(fmtTokens(1000), "1.0k"); // <10k gets 1 decimal
  assert.equal(fmtTokens(1500), "1.5k");
  assert.equal(fmtTokens(15000), "15k"); // >=10k gets 0 decimals
  assert.equal(fmtTokens(999999), "1000k"); // quirk: rounds up instead of flipping to M
  assert.equal(fmtTokens(1_000_000), "1.00M");
  assert.equal(fmtTokens(2_500_000), "2.50M");
});

test("fmtCost: dash, zero, tiny, normal", () => {
  assert.equal(fmtCost(undefined), "—");
  assert.equal(fmtCost(0), "$0");
  assert.equal(fmtCost(0.0042), "$0.0042"); // <0.01 gets 4 decimals
  assert.equal(fmtCost(0.5), "$0.500"); // <1 gets 3 decimals
  assert.equal(fmtCost(1.5), "$1.50");
  assert.equal(fmtCost(25), "$25.00");
});

test("fmtUptime: dash for an absent age, then m / h+m / d+h", () => {
  // a procs row can come from a node-agent still on an older bundle, which
  // does not send ageSec — it must degrade to the placeholder, not "NaNm"
  assert.equal(fmtUptime(undefined), "—");
  assert.equal(fmtUptime(NaN), "—");
  assert.equal(fmtUptime(0), "0m");
  assert.equal(fmtUptime(59), "0m"); // sub-minute rounds down to a whole minute, as before
  assert.equal(fmtUptime(11_100), "3h 5m");
  assert.equal(fmtUptime(90_061), "1d 1h");
});

test("ago: now, s, m, h, d, future clamps to now", () => {
  const now = 1_700_000_000_000;
  assert.equal(ago(now, now), "now");
  assert.equal(ago(now - 4_400, now), "now");
  assert.equal(ago(now - 4_999, now), "5s"); // quirk: Math.round(4.999)=5, so "now" only holds below 4.5s
  assert.equal(ago(now - 30_000, now), "30s");
  assert.equal(ago(now - 59_000, now), "59s");
  assert.equal(ago(now - 5 * 60_000, now), "5m");
  assert.equal(ago(now - 2 * 3_600_000, now), "2h");
  assert.equal(ago(now - 2 * 86_400_000, now), "2d");
  assert.equal(ago(now + 60_000, now), "now"); // future timestamps clamp via Math.max(0, ...)
});

test("daysLeftInTrash: the purge countdown a trash row shows (issue #5 asks for days-remaining, not time-since-delete)", () => {
  const now = 1_700_000_000_000;
  const day = 86_400_000;
  assert.equal(TRASH_RETENTION_DAYS, 30, "same window as the server's TRASH_RETENTION_MS");
  assert.equal(daysLeftInTrash(now, now), 30, "just deleted: the full window left");
  assert.equal(daysLeftInTrash(now - day, now), 29);
  assert.equal(daysLeftInTrash(now - 29 * day, now), 1);
  assert.equal(daysLeftInTrash(now - 29 * day - 3_600_000, now), 1, "23h left still reads 1 — the last day never rounds to 0 early");
  assert.equal(daysLeftInTrash(now - 30 * day, now), 0, "at the window it is purged");
  assert.equal(daysLeftInTrash(now - 45 * day, now), 0, "long past the window clamps at 0");
});

test("until: countdown twin of ago — future reads as time LEFT, past clamps to now", () => {
  const now = 1_700_000_000_000;
  /* the pairing-code bug: expiresAt is 10 minutes AHEAD, and ago() clamped
     that to "now" — the caption always read "expires now" */
  assert.equal(until(now + 10 * 60_000, now), "10m");
  assert.equal(until(now + 30_000, now), "30s");
  assert.equal(until(now + 4_400, now), "now");
  assert.equal(until(now + 2 * 3_600_000, now), "2h");
  assert.equal(until(now + 2 * 86_400_000, now), "2d");
  assert.equal(until(now, now), "now");
  assert.equal(until(now - 60_000, now), "now"); // past timestamps clamp via Math.max(0, ...)
});

test("nextRunHint: weekday+time within a week, month+day beyond (issue #16)", () => {
  /* local-time fixtures, same contract as the server-side cron suite */
  const now = new Date(2026, 0, 7, 12, 0, 0).getTime(); // a Wednesday
  const monday = new Date(2026, 0, 12, 9, 0).getTime();
  assert.equal(nextRunHint(monday, now), "Mon 09:00");
  const sameDay = new Date(2026, 0, 7, 12, 30).getTime();
  assert.equal(nextRunHint(sameDay, now), "Wed 12:30");
  /* past the 7-day horizon the weekday alone would lie about which week */
  const leapDay = new Date(2028, 1, 29, 0, 0).getTime();
  assert.equal(nextRunHint(leapDay, now), "Feb 29, 00:00");
  /* single digits zero-pad */
  const early = new Date(2026, 0, 8, 6, 5).getTime();
  assert.equal(nextRunHint(early, now), "Thu 06:05");
});

test("fmtSize: B rounding, KB decimals, MB/GB/TB boundaries", () => {
  assert.equal(fmtSize(0), "0 B");
  assert.equal(fmtSize(42.66), "43 B"); // fractions rounded for bytes
  assert.equal(fmtSize(1023), "1023 B");
  assert.equal(fmtSize(1023.5), "1.0 KB"); // quirk: Math.round(1023.5)=1024 tips it into the KB branch
  assert.equal(fmtSize(1024), "1.0 KB"); // <10KB gets 1 decimal
  assert.equal(fmtSize(5120), "5.0 KB");
  assert.equal(fmtSize(10240), "10 KB"); // >=10KB gets 0 decimals
  assert.equal(fmtSize(100 * 1024), "100 KB");
  assert.equal(fmtSize(1024 ** 2), "1.0 MB");
  assert.equal(fmtSize(1.5 * 1024 ** 2), "1.5 MB");
  assert.equal(fmtSize(1024 ** 3), "1.0 GB");
  assert.equal(fmtSize(1024 ** 4), "1.0 TB");
  assert.equal(fmtSize(2.5 * 1024 ** 4), "2.5 TB");
});

test("shortPath: $HOME collapse for linux/mac, others untouched", () => {
  assert.equal(shortPath("/home/ubuntu/projects/truss"), "~/projects/truss");
  assert.equal(shortPath("/Users/alice/x"), "~/x");
  assert.equal(shortPath("/home/ubuntu"), "~");
  assert.equal(shortPath("/var/log/syslog"), "/var/log/syslog");
  assert.equal(shortPath("src/lib/format.ts"), "src/lib/format.ts");
  assert.equal(shortPath("/home"), "/home"); // no user segment -> untouched
});

test("argSummary: nullish, passthrough, primitives, preferred keys, truncation", () => {
  assert.equal(argSummary(null), "");
  assert.equal(argSummary(undefined), "");
  assert.equal(argSummary("ls -la"), "ls -la");
  assert.equal(argSummary(42), "42");
  assert.equal(argSummary(true), "true");
  // preferred keys in priority order: command beats path
  assert.equal(argSummary({ command: "ls", path: "/tmp" }), "ls");
  assert.equal(argSummary({ file_path: "/a.ts" }), "/a.ts");
  assert.equal(argSummary({ pattern: "*.ts" }), "*.ts");
  assert.equal(argSummary({ description: "d" }), "d");
  assert.equal(argSummary({ url: "https://x" }), "https://x");
  assert.equal(argSummary({ query: "q" }), "q");
  // no preferred key -> JSON
  assert.equal(argSummary({ a: 1 }), '{"a":1}');
  // long JSON truncated to 90 chars + ellipsis
  const big = { text: "x".repeat(100) };
  const out = argSummary(big);
  assert.equal(out.length, 91);
  assert.ok(out.endsWith("…"));
  assert.equal(out, JSON.stringify(big).slice(0, 90) + "…");
});

test("deadSessionHint: suppressed while the error banner is up, shown when dead, never when alive", () => {
  assert.equal(deadSessionHint(true, false, "hermes"), "Not running — sending resumes hermes with its history.");
  assert.equal(
    deadSessionHint(true, true, "hermes"),
    null,
    "the banner already says the session can't be resumed — the hint must not contradict it",
  );
  assert.equal(deadSessionHint(false, false, "hermes"), null);
  assert.equal(deadSessionHint(false, true, "hermes"), null);
});

test("fmtTakeTime: recording-clock style for the dictation chip (issue #112)", () => {
  assert.equal(fmtTakeTime(0), "0:00");
  assert.equal(fmtTakeTime(999), "0:00", "sub-second floors, never rounds up");
  assert.equal(fmtTakeTime(7000), "0:07");
  assert.equal(fmtTakeTime(59_999), "0:59");
  assert.equal(fmtTakeTime(60_000), "1:00");
  assert.equal(fmtTakeTime(754_000), "12:34");
  assert.equal(fmtTakeTime(-5), "0:00", "a clock skew never shows a negative");
  assert.equal(fmtTakeTime(NaN), "0:00", "garbage in, calm zero out");
});
