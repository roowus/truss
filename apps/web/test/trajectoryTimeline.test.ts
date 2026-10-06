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
