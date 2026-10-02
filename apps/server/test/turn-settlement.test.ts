import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshServer, tick } from "./helpers.js";
import type { AdapterHandle, HarnessAdapter, SessionOpts } from "../src/adapters/types.js";
import type { ProtoEvent } from "@truss/proto";

/* SPEC-TESTS for mid-turn harness death + the pi feed gap —
   https://github.com/roowus/truss/issues/29
   (User report: pi died mid-chat while writing a report; the chat froze
   and nothing reached the feed). These FAIL on purpose today: they pin the
   contract a fix must satisfy.

   Root causes (evidence in the issue):
   A. pi's exit handler (adapters/pi.ts:216-221) marks the session error but
      leaves the OPEN assistant message and the OPEN llm.call unsettled — the
      bubble streams forever, the trajectory row hangs in-flight, and
      downstream consumers that key off completion never fire.
      (Also pinned: pi.ts hardcodes spawn("pi") — the fix must add
      TRUSS_PI_BIN, the same seam TRUSS_HERMES_BIN proved.)
   B. pi has no MCP, so content reaches the feed only via auto-posters — and
      the work_done card carries just "Turn settled after Ns"
      (feed-autopost.ts:65-71), never what the turn actually produced. The
      user's report existed only as chat text, so the feed got nothing useful.

   The contract:
   A. A mid-turn process exit settles the turn truthfully BEFORE the error
      state: msg.done (stopReason mentions the exit) for the open bubble +
      llm.call.done (status ≥ 500) for the open call.
   B. The work_done auto-card's body carries a bounded excerpt of the turn's
      final assistant text (and sessionId stays for click-through), falling
      back to today's duration note when the turn produced no text. */

const PI_DIR = mkdtempSync(join(tmpdir(), "truss-fake-pi-"));
/* fake pi --mode rpc: answers get_state, starts a turn, streams one chunk,
   then DIES mid-turn (no message_end / turn_end / agent_settled) */
const FAKE_PI = `
let b = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  b += c;
  let i;
  while ((i = b.indexOf("\\n")) >= 0) {
    const l = b.slice(0, i).trim(); b = b.slice(i + 1);
    if (!l) continue;
    let r; try { r = JSON.parse(l); } catch { continue; }
    if (r.type === "get_state") {
      process.stdout.write(JSON.stringify({ id: r.id, type: "response", success: true, data: { sessionId: "fake-pi-session" } }) + "\\n");
      /* now the doomed turn */
      process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "turn_start" }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "message_start", message: { role: "assistant" } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial report — never finished…" } }) + "\\n");
      setTimeout(() => process.exit(1), 150);
    }
  }
});
`;
writeFileSync(join(PI_DIR, "fake-pi.cjs"), FAKE_PI);
const PI_BIN = join(PI_DIR, "fake-pi.sh");
writeFileSync(PI_BIN, `#!/bin/sh\nexec ${process.execPath} ${join(PI_DIR, "fake-pi.cjs")}\n`, { mode: 0o755 });

test("A: a mid-turn pi exit settles the open bubble + open call before the error state (needs TRUSS_PI_BIN)", async () => {
  const { cleanup } = await freshServer("pi-death");
  try {
    process.env.TRUSS_PI_BIN = PI_BIN;
    const { piAdapter } = await import("../src/adapters/pi.js");

    const h = await piAdapter.spawn({ sessionId: "death-1", cwd: "/tmp" });
    /* drain until the queue closes (process exit closes it); if a real pi
       was spawned instead (pre-fix: TRUSS_PI_BIN ignored), nothing arrives —
       the race below turns that hang into the assertion failure */
    const seen: ProtoEvent[] = [];
    const drained = (async () => {
      for await (const ev of piAdapter.events(h)) seen.push(ev);
    })();
    await Promise.race([drained, tick(6000)]);
    try {
      piAdapter.dispose(h);
    } catch {}

    const states = seen.filter((e) => e.type === "session.state").map((e) => (e as any).state);
    const msgDone = seen.find((e) => e.type === "msg.done");
    assert.ok(msgDone, "the open assistant bubble is CLOSED — today it streams forever (the frozen chat)");
    assert.match(String((msgDone as any)?.stopReason ?? ""), /error|exit|died|crash/i, "the bubble's stopReason says why");
    const callDone = seen.find((e) => e.type === "llm.call.done");
    assert.ok(callDone, "the open llm.call is settled — today it hangs in-flight forever");
    assert.ok(((callDone as any)?.status ?? 0) >= 500, "the call closes as a failure, not a success");
    assert.ok(states.includes("error"), "the session still ends in error state (today's behavior, kept)");
  } finally {
    delete process.env.TRUSS_PI_BIN;
    cleanup();
  }
});

/* ── B: the work_done card carries the turn's output ── */

/** scripted adapter: runs one full turn producing a report, then idles.
    report = null scripts a turn with NO assistant text (tool-only), which
    must fall back to today's duration line. The default report is padded
    past the 600-char excerpt cap so the bound assertion bites. */
function scriptedAdapter(id: string, report: string | null = "REPORT-MARKER: hermes is novel because… " + "x".repeat(800)): HarnessAdapter {
  let sid = "unset";
  return {
    id: id as never,
    capabilities: { permissions: false, subagents: false, streaming: true, queueWhileRunning: true },
    async listModels() {
      return [];
    },
    async spawn(opts: SessionOpts): Promise<AdapterHandle> {
      sid = opts.sessionId;
      return { sessionId: opts.sessionId };
    },
    send() {},
    interrupt() {},
    async *events(): AsyncIterable<ProtoEvent> {
      /* pump the scripted turn once goLive has subscribed */
      await tick(50);
      yield { type: "session.state", sessionId: sid, state: "running" } as ProtoEvent;
      yield { type: "msg.start", sessionId: sid, messageId: "m-report", role: "assistant", at: Date.now() } as ProtoEvent;
      if (report !== null) {
        yield { type: "msg.chunk", sessionId: sid, messageId: "m-report", text: report, channel: "text" } as ProtoEvent;
      }
      yield { type: "msg.done", sessionId: sid, messageId: "m-report" } as ProtoEvent;
      yield { type: "llm.call.done", sessionId: sid, callId: "c1", status: 200, latencyMs: 1200 } as ProtoEvent;
      yield { type: "session.state", sessionId: sid, state: "idle" } as ProtoEvent;
      await new Promise(() => {}); // stay live
    },
    dispose() {},
  };
}

test("B: the work_done feed card carries a bounded excerpt of the turn's final assistant text", async () => {
  const { cleanup } = await freshServer("pi-feed-content");
  try {
    const sessions = await import("../src/sessions.js");
    const feed = await import("../src/feed.js");
    const autopost = await import("../src/feed-autopost.js");
    sessions.registerAdapter("fake-feedcast" as never, scriptedAdapter("fake-feedcast"));
    sessions.registerAdapter("fake-silent" as never, scriptedAdapter("fake-silent", null));
    try {
      autopost.startFeedAutopost(); // module-level listener; once per file

      const s = await sessions.createSession({ harness: "fake-feedcast" as never, cwd: "/tmp", title: "novelty report" });
      const deadline = Date.now() + 5000;
      let card: any;
      while (Date.now() < deadline) {
        card = feed.listFeed({}).find((i: any) => i.type === "work_done" && i.sessionId === s.id);
        if (card) break;
        await tick(100);
      }
      assert.ok(card, "a work_done card posts when the turn settles");
      assert.ok(card.body.includes("REPORT-MARKER"), `the card carries WHAT the turn produced — today it's only "${"Turn settled after Ns"}"; got: ${card.body}`);
      /* the implementation cap is 600 chars + the ellipsis (feed-autopost.ts):
         assert against THAT, not a loose transcript-sized bound */
      assert.ok(card.body.length <= 601, `bounded at the real cap (600 + …), not the whole transcript; got ${card.body.length}`);
      assert.ok(card.body.endsWith("…"), "an over-cap report is truncated with the ellipsis");
      assert.equal(card.sessionId, s.id, "click-through to the session stays");

      /* the no-text fallback: a tool-only turn (no text chunks) keeps today's
         duration line — returning "" instead of null here would blank the
         card on every harness, unpinned */
      const silent = await sessions.createSession({ harness: "fake-silent" as never, cwd: "/tmp", title: "tool-only turn" });
      let silentCard: any;
      const deadline2 = Date.now() + 5000;
      while (Date.now() < deadline2) {
        silentCard = feed.listFeed({}).find((i: any) => i.type === "work_done" && i.sessionId === silent.id);
        if (silentCard) break;
        await tick(100);
      }
      assert.ok(silentCard, "a work_done card posts for the no-text turn too");
      assert.match(silentCard.body, /^Turn settled after \d+s\.$/, "no assistant text → the duration-line fallback, not a blank card");
    } finally {
      sessions.unregisterAdapter("fake-feedcast" as never);
      sessions.unregisterAdapter("fake-silent" as never);
    }
  } finally {
    cleanup();
  }
});

import { after } from "node:test";
after(() => {
  try {
    rmSync(PI_DIR, { recursive: true, force: true });
  } catch {}
});
