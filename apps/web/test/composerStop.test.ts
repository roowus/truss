import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* SPEC-TESTS for Stop living in the composer — https://github.com/roowus/truss/issues/179
   ("The Stop button is at the top of the bar; it should be in the chat bar
   — the Send button becomes Stop while the session is running"). These
   FAIL on purpose today: they pin the contract a fix must satisfy.

   Today (ChatPanel.tsx): Stop is DUPLICATED — a header Stop (:164) plus the
   composer's send→stop swap (:888). And the swap has a hole: with
   queueWhileRunning the composer shows "Queue" and Stop exists ONLY in the
   header — removing the header button without closing that hole would
   strand the interrupt.

   The contract: src/lib/composerActions.ts —

     composerActions({ running, queues, dead, sending }):
       { primary: "send" | "queue" | "stop" | "resume"; stop?: boolean }

   - idle → send;
   - running, no queueing → the primary IS stop (Send becomes Stop);
   - running WITH queueing → primary queue + a stop alongside (interrupt
     never disappears);
   - dead → resume (the existing wake-and-send);
   - header carries no Stop at all (read-through pin). */

interface ComposerActionsModule {
  composerActions(state: { running: boolean; queues: boolean; dead: boolean; sending?: boolean }): {
    primary: "send" | "queue" | "stop" | "resume";
    stop?: boolean;
  };
}

async function load(): Promise<ComposerActionsModule | null> {
  const spec = "../src/lib/composerActions"; // variable specifier: typechecks before the module exists
  return import(spec).catch(() => null);
}

test("src/lib/composerActions.ts exists", async () => {
  const mod = await load();
  assert.ok(mod, "src/lib/composerActions.ts must export composerActions — see issue #179");
});

test("the matrix: send → stop swap, queue keeps a stop beside it, dead resumes", async () => {
  const mod = await load();
  assert.ok(mod, "composerActions must exist (see module test)");

  assert.deepEqual(mod.composerActions({ running: false, queues: false, dead: false }), { primary: "send" }, "idle sends");
  assert.deepEqual(mod.composerActions({ running: true, queues: false, dead: false }), { primary: "stop" }, "running: the button BECOMES stop — the ask");
  const queued = mod.composerActions({ running: true, queues: true, dead: false });
  assert.equal(queued.primary, "queue", "queue-capable still queues");
  assert.equal(queued.stop, true, "…and stop is RIGHT THERE beside it — interrupt never strands");
  assert.deepEqual(mod.composerActions({ running: false, queues: false, dead: true }), { primary: "resume" }, "dead resumes (existing)");

  /* sanity: a busy/sending draft doesn't double-act */
  assert.equal(mod.composerActions({ running: false, queues: false, dead: false, sending: true }).primary, "send");
});

test("read-through: the header carries no Stop; the composer owns it", () => {
  const src = readFileSync(new URL("../src/panels/ChatPanel.tsx", import.meta.url), "utf8");
  const headerStart = src.indexOf('className="relative shrink-0 flex items-center gap-2 px-3 h-10 border-b');
  const composerStart = src.indexOf("flex items-end gap-1.5 rounded-xl border");
  assert.ok(headerStart > 0 && composerStart > headerStart, "both regions found");
  const headerRegion = src.slice(headerStart, composerStart);
  const composerRegion = src.slice(composerStart);
  assert.ok(!/store\.interrupt/.test(headerRegion), "the header loses its Stop — the composer is the only home (issue #179)");
  assert.ok(/store\.interrupt/.test(composerRegion) && /composerActions\(/.test(composerRegion), "the composer's buttons come from composerActions");
});
