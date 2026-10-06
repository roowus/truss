import { test } from "node:test";
import assert from "node:assert/strict";

/* SPEC-TESTS for the trajectory timeline — https://github.com/roowus/truss/issues/142
   ("The trajectory tab should show the timeline like DSH's does, and in
   general show more information"). These FAIL on purpose today: they pin
   the contract a fix must satisfy.

   Today (TrajectoryPanel.tsx): a stats strip + a table of raw LLM CALLS
   (the #20 request timeline) — not the session's story. DSH's reference
   (ui-trajectory, read): a chronological ledger grouped by turn, tool calls
   inline with durations, per-record metrics, and an overview timeline.

   The contract: a pure projection of the event log the session already
   records — src/lib/trajectoryTimeline.ts —

     trajectoryTimeline(events): TimelineTurn[]

   TimelineTurn = {
     at, user?: { text }, assistant?: { at, doneAt?, durationMs?, model? },
     tools: [{ name, at, doneAt?, durationMs?, ok? }],
     tokensIn?, tokensOut?,
   }

   Rules:
   - turns group user→assistant (+ the tools between) chronologically;
   - tool calls interleave by time within their turn;
   - durations only from real done−start pairs — unclosed spans are marked
     in-flight, never given fake durations;
   - orphan tools (no surrounding messages) still appear (their own turn);
   - replay-safe: the same events in produce the same timeline, and junk
     never throws. */

interface TimelineTool {
  name: string;
  at: number;
  doneAt?: number;
  durationMs?: number;
  ok?: boolean;
}
interface TimelineTurn {
  at: number;
  user?: { text: string };
  assistant?: { at: number; doneAt?: number; durationMs?: number; model?: string };
  tools: TimelineTool[];
  tokensIn?: number;
  tokensOut?: number;
}
interface TrajectoryTimelineModule {
  trajectoryTimeline(events: { type: string; at?: number; [k: string]: unknown }[]): TimelineTurn[];
}

async function load(): Promise<TrajectoryTimelineModule | null> {
  const spec = "../src/lib/trajectoryTimeline"; // variable specifier: typechecks before the module exists
  return import(spec).catch(() => null);
}

/* overview-strip geometry — the Chrome-Network-style strip above the feed
   (developer feedback on PR #151): one segment per turn over the full span */
interface TimelineOverviewModule {
  timelineOverview(turns: TimelineTurn[], now: number): {
    start: number;
    end: number;
    segments: { turnIndex: number; start: number; end: number; inFlight: boolean; failed: boolean }[];
  } | null;
}

const T0 = 1_000_000;
const ev = (type: string, at: number, extra: Record<string, unknown> = {}) => ({ type, at: T0 + at, sessionId: "s", ...extra });

/* a realistic two-turn event sequence */
const EVENTS = [
  ev("msg.start", 0, { messageId: "u1", role: "user" }),
  ev("msg.chunk", 1, { messageId: "u1", text: "list the files" }),
  ev("msg.done", 2, { messageId: "u1" }),
  ev("llm.call.start", 3, { callId: "t1", model: "glm-4.7" }),
  ev("msg.start", 4, { messageId: "a1", role: "assistant" }),
  ev("tool.start", 5, { callId: "tc1", name: "bash" }),
  ev("tool.done", 350, { callId: "tc1", ok: true }),
  ev("msg.done", 400, { messageId: "a1" }),
  ev("llm.call.done", 401, { callId: "t1", status: 200, latencyMs: 398, tokensIn: 1200, tokensOut: 90 }),
  ev("msg.start", 5000, { messageId: "u2", role: "user" }),
  ev("msg.chunk", 5001, { messageId: "u2", text: "now the tests" }),
  ev("msg.done", 5002, { messageId: "u2" }),
  ev("msg.start", 5010, { messageId: "a2", role: "assistant" }),
  /* a tool that never finishes — in flight */
  ev("tool.start", 5011, { callId: "tc2", name: "read" }),
];

test("src/lib/trajectoryTimeline.ts exists", async () => {
  const mod = await load();
  assert.ok(mod, "src/lib/trajectoryTimeline.ts must export trajectoryTimeline — see issue #142");
});

test("turns group user→assistant with tools inline, chronologically, with real durations", async () => {
  const mod = await load();
  assert.ok(mod, "trajectoryTimeline module must exist (see module test)");
  const turns = mod.trajectoryTimeline(EVENTS);

  assert.equal(turns.length, 2, "two turns");
  const [first, second] = turns;
  assert.equal(first.user?.text, "list the files");
  assert.ok(first.assistant, "the assistant half of the turn");
  assert.equal(first.assistant!.durationMs, 400 - 4, "assistant span measured from its real start→done");
  assert.equal(first.assistant!.model, "glm-4.7", "the model rides the turn (the 'more information' ask)");
  assert.equal(first.tokensIn, 1200, "per-turn tokens when the harness reports them");

  assert.equal(first.tools.length, 1);
  assert.equal(first.tools[0].name, "bash");
  assert.equal(first.tools[0].durationMs, 350 - 5, "tool duration from its own start→done");
  assert.equal(first.tools[0].ok, true);

  /* the in-flight tool: present, marked, no fabricated duration */
  assert.equal(second.tools.length, 1);
  assert.equal(second.tools[0].name, "read");
  assert.equal(second.tools[0].durationMs, undefined, "no done → no fake duration");
  assert.equal(second.tools[0].doneAt, undefined);

  /* chronological */
  assert.ok(turns[1].at > turns[0].at);
});

test("orphan tools still appear; replay is identical; junk never throws", async () => {
  const mod = await load();
  assert.ok(mod, "trajectoryTimeline module must exist (see module test)");

  const orphans = mod.trajectoryTimeline([ev("tool.start", 10, { callId: "tc9", name: "orphan" }), ev("tool.done", 60, { callId: "tc9", ok: false })]);
  assert.equal(orphans.length, 1, "an orphan tool gets its own entry — never silently dropped");
  assert.equal(orphans[0].tools[0].name, "orphan");
  assert.equal(orphans[0].tools[0].ok, false);

  assert.deepEqual(mod.trajectoryTimeline(EVENTS), mod.trajectoryTimeline(EVENTS), "replay-stable");
  assert.doesNotThrow(() => mod.trajectoryTimeline([{ type: "mystery" } as never, null as never].filter(Boolean) as never[]));
  assert.deepEqual(mod.trajectoryTimeline([]), []);
});

/* regression for the round-1 audit (B3): an assistant message that precedes
   the first user message (a resumed or harness-initiated session can open
   with one) must get its own turn, not be silently dropped */
test("an assistant message before the first user message gets its own turn", async () => {
  const mod = await load();
  assert.ok(mod, "trajectoryTimeline module must exist (see module test)");

  const turns = mod.trajectoryTimeline([
    ev("msg.start", 0, { messageId: "a0", role: "assistant" }),
    ev("msg.chunk", 1, { messageId: "a0", text: "session resumed" }),
    ev("msg.done", 50, { messageId: "a0" }),
    ev("msg.start", 100, { messageId: "u1", role: "user" }),
    ev("msg.chunk", 101, { messageId: "u1", text: "hi" }),
    ev("msg.done", 102, { messageId: "u1" }),
  ]);

  assert.equal(turns.length, 2, "the leading assistant message is its own turn");
  assert.ok(!turns[0].user && turns[0].assistant, "assistant-only turn");
  assert.equal(turns[0].assistant!.durationMs, 50, "its span still measured from the real pair");
  assert.equal(turns[1].user?.text, "hi");
  assert.ok(turns[1].at > turns[0].at, "chronological");
});

test("timelineOverview: one segment per turn over the full span, in-flight ends move with the caller's clock", async () => {
  const mod = (await load()) as (TrajectoryTimelineModule & TimelineOverviewModule) | null;
  assert.ok(mod, "trajectoryTimeline module must exist (see module test)");

  const turns = mod.trajectoryTimeline(EVENTS);
  const NOW = T0 + 10_000;
  const ov = mod.timelineOverview(turns, NOW);
  assert.ok(ov, "an overview for a non-empty timeline");
  assert.equal(ov.start, T0, "span starts at the first turn");
  assert.equal(ov.segments.length, 2, "one segment per turn");

  const settled = ov.segments[0];
  assert.equal(settled.start, T0);
  assert.equal(settled.end, T0 + 400, "a settled turn ends at its real last done (assistant done, after the tool's)");
  assert.equal(settled.inFlight, false);
  assert.equal(settled.failed, false);

  const live = ov.segments[1];
  assert.equal(live.inFlight, true, "the unclosed tool marks the turn in flight");
  assert.equal(live.end, NOW, "an in-flight turn's end is the caller's clock, never a fabricated done");
  assert.equal(ov.end, NOW, "the span grows with the live session");
  assert.ok(ov.end > ov.start);

  /* a failed tool flags its segment */
  const failed = mod.timelineOverview(mod.trajectoryTimeline([ev("tool.start", 10, { callId: "tc9", name: "orphan" }), ev("tool.done", 60, { callId: "tc9", ok: false })]), NOW);
  assert.equal(failed!.segments[0].failed, true);
  assert.equal(failed!.segments[0].end, T0 + 60, "orphan tool turn ends at its done");

  /* degenerate and empty inputs */
  assert.equal(mod.timelineOverview([], NOW), null);
  const point = mod.timelineOverview(mod.trajectoryTimeline([ev("msg.start", 0, { messageId: "u", role: "user" })]), NOW);
  assert.ok(point!.end > point!.start, "a zero-width session still gets a positive span (no divide-by-zero)");
});
