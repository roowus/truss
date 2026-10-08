import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProtoEvent } from "../src/lib/proto";

// store.ts touches `window` at module scope (`(window as any).__truss = store`).
// That is the ONLY browser global referenced at import time (the Store
// constructor itself only builds plain data; requestAnimationFrame/document are
// used inside methods, not at import), so this one shim is sufficient.
// It must be installed BEFORE the module is imported — hence a dynamic import
// (static imports are hoisted and would evaluate store.ts before the shim).
(globalThis as any).window ??= {};
/* Store-level tests drive onFrame (session.updated) and init (the boot-probe
   pin), which schedule notifications via requestAnimationFrame — shim it for
   them; everything else still uses the pure reduce path */
(globalThis as any).requestAnimationFrame ??= (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0);
/* refreshSessionsSoon (reached by the restore path) schedules via
   window.setTimeout */
(globalThis as any).window.setTimeout ??= globalThis.setTimeout.bind(globalThis);
const { reduce, emptyView, toMs, store } = await import("../src/lib/store");

const T0 = 1_000; // arbitrary frameTime base

test("toMs: seconds->ms, ms passthrough, ISO strings, undefined->now", () => {
  assert.equal(toMs(1_700_000_000), 1_700_000_000_000); // <1e12 treated as seconds
  assert.equal(toMs(999_999_999_999), 999_999_999_999_000); // just under the boundary
  assert.equal(toMs(1_700_000_000_000), 1_700_000_000_000); // >=1e12 treated as ms
  assert.equal(toMs("2024-01-01T00:00:00.000Z"), 1_704_067_200_000); // ISO parsed
  const before = Date.now();
  const t = toMs(undefined);
  assert.ok(t >= before && t <= Date.now()); // undefined -> now
  const u = toMs("not-a-date");
  assert.ok(u >= before && u <= Date.now()); // unparseable -> now
});

test("msg.start: creates message with role, empty segments, done=false; duplicate is a no-op", () => {
  let v = emptyView();
  v = reduce(v, { sessionId: "s", type: "msg.start", messageId: "m1", role: "user", at: 1_700_000_000 }, T0);
  const m = v.msgs.m1;
  assert.equal(m.role, "user");
  assert.deepEqual(m.segments, []);
  assert.equal(m.done, false);
  assert.equal(m.at, 1_700_000_000_000); // at runs through toMs (seconds -> ms)
  assert.deepEqual(v.items, [{ kind: "msg", id: "m1" }]);
  const v2 = reduce(v, { sessionId: "s", type: "msg.start", messageId: "m1", role: "assistant", at: 5 }, T0);
  assert.equal(v2, v); // same reference: second start for an existing message is ignored
});

test("msg.chunk: implicit create, same-channel chunks merge, thinking splits segments", () => {
  let v = emptyView();
  // no msg.start: a chunk implicitly creates an assistant message stamped with frameTime
  v = reduce(v, { sessionId: "s", type: "msg.chunk", messageId: "m1", text: "Hel" }, 111);
  v = reduce(v, { sessionId: "s", type: "msg.chunk", messageId: "m1", text: "lo" }, 222);
  v = reduce(v, { sessionId: "s", type: "msg.chunk", messageId: "m1", text: "thinking...", channel: "thinking" }, 333);
  v = reduce(v, { sessionId: "s", type: "msg.chunk", messageId: "m1", text: " more", channel: "thinking" }, 444);
  v = reduce(v, { sessionId: "s", type: "msg.chunk", messageId: "m1", text: "answer" }, 555);
  const m = v.msgs.m1;
  assert.equal(m.role, "assistant");
  assert.equal(m.at, 111); // implicit create uses the frame time
  // consecutive same-channel chunks merge; channel switches start new segments
  assert.deepEqual(m.segments, [
    { channel: "text", text: "Hello" },
    { channel: "thinking", text: "thinking... more" },
    { channel: "text", text: "answer" },
  ]);
  assert.deepEqual(v.items, [{ kind: "msg", id: "m1" }]); // single item, appended on first chunk

  /* issue #142 audit (B8): when the chunk carries the sink's stamp, the
     implicit create takes it — not the client frame clock — so the message
     stays on one clock with its doneAt */
  let v2 = emptyView();
  const S = 1_760_000_000_000; // ms-scale stamp (toMs treats <1e12 as seconds)
  v2 = reduce(v2, { sessionId: "s", type: "msg.chunk", messageId: "m9", text: "x", at: S }, 111);
  assert.equal(v2.msgs.m9.at, S);
});

test("msg.done: marks done and preserves stopReason verbatim (provider errors survive to the UI pill)", () => {
  let v = emptyView();
  v = reduce(v, { sessionId: "s", type: "msg.start", messageId: "m1", role: "assistant", at: 0 }, T0);
  v = reduce(v, { sessionId: "s", type: "msg.done", messageId: "m1", stopReason: "error: 400 Unknown Model" }, T0 + 250);
  const m = v.msgs.m1;
  assert.equal(m.done, true);
  assert.equal(m.doneAt, T0 + 250); // issue #142: the trajectory timeline measures the real assistant span
  assert.equal(m.stopReason, "error: 400 Unknown Model"); // regression: must not be mangled/dropped
  // msg.done for an unknown message is a no-op (no implicit creation)
  const v2 = reduce(v, { sessionId: "s", type: "msg.done", messageId: "ghost", stopReason: "x" }, T0);
  assert.equal(v2, v);
  assert.equal(v2.msgs.ghost, undefined);
});

test("msg.done: the event's own stamp beats frameTime (one server clock for the whole span, issue #142 audit)", () => {
  /* the sink stamps `at` on every event that lacks one; when it is present
     the reducer must use it, or the assistant span mixes the server clock
     (msg.start's at) with the client's (frameTime) and skew can bend or
     negate the duration. Server-shaped replay: at present, frameTime just
     the replay clock. */
  let v = emptyView();
  const S = 1_760_000_000_000; // ms-scale server stamp (toMs treats <1e12 as seconds)
  v = reduce(v, { sessionId: "s", type: "msg.start", messageId: "m1", role: "assistant", at: S }, T0);
  v = reduce(v, { sessionId: "s", type: "msg.done", messageId: "m1", at: S + 400 }, T0);
  assert.equal(v.msgs.m1.doneAt, S + 400, "done time comes from the event, not the frame clock");
  assert.equal(v.msgs.m1.doneAt! - v.msgs.m1.at, 400, "a real, same-clock span");
});

test("interleaving: concurrently streaming messages keep their own segments", () => {
  let v = emptyView();
  v = reduce(v, { sessionId: "s", type: "msg.chunk", messageId: "a", text: "A1" }, 1);
  v = reduce(v, { sessionId: "s", type: "msg.chunk", messageId: "b", text: "B1" }, 2);
  v = reduce(v, { sessionId: "s", type: "msg.chunk", messageId: "a", text: "A2" }, 3);
  v = reduce(v, { sessionId: "s", type: "msg.chunk", messageId: "b", text: "B2", channel: "thinking" }, 4);
  assert.deepEqual(v.msgs.a.segments, [{ channel: "text", text: "A1A2" }]); // merged within message a
  assert.deepEqual(v.msgs.b.segments, [
    { channel: "text", text: "B1" },
    { channel: "thinking", text: "B2" },
  ]);
  assert.deepEqual(
    v.items.map((i) => i.id),
    ["a", "b"],
  );
});

test("tool.call/update/done: run lifecycle, status, explicit and derived durationMs", () => {
  let v = emptyView();
  v = reduce(v, { sessionId: "s", type: "tool.call", toolCallId: "t1", name: "bash", args: { command: "ls" } }, 1000);
  let t = v.tools.t1;
  assert.equal(t.status, "running");
  assert.equal(t.startedAt, 1000); // startedAt is the frame time, not event data
  assert.deepEqual(t.args, { command: "ls" });
  assert.deepEqual(v.items, [{ kind: "tool", id: "t1" }]);
  // duplicate call is ignored
  assert.equal(reduce(v, { sessionId: "s", type: "tool.call", toolCallId: "t1", name: "bash", args: {} }, 1100), v);
  // update records output, stays running
  v = reduce(v, { sessionId: "s", type: "tool.update", toolCallId: "t1", output: "partial" }, 1500);
  assert.equal(v.tools.t1.output, "partial");
  assert.equal(v.tools.t1.status, "running");
  // update with output:undefined is a no-op (same reference)
  assert.equal(reduce(v, { sessionId: "s", type: "tool.update", toolCallId: "t1" }, 1600), v);
  // done: explicit durationMs wins
  v = reduce(v, { sessionId: "s", type: "tool.done", toolCallId: "t1", ok: false, output: "boom", durationMs: 42 }, 3000);
  t = v.tools.t1;
  assert.equal(t.status, "fail");
  assert.equal(t.durationMs, 42);
  assert.equal(t.output, "boom");
  // done without durationMs derives it from frameTime - startedAt; done without output keeps prior output
  v = reduce(v, { sessionId: "s", type: "tool.call", toolCallId: "t2", name: "read", args: {} }, 2000);
  v = reduce(v, { sessionId: "s", type: "tool.update", toolCallId: "t2", output: "kept" }, 2100);
  v = reduce(v, { sessionId: "s", type: "tool.done", toolCallId: "t2", ok: true }, 2500);
  assert.equal(v.tools.t2.status, "ok");
  assert.equal(v.tools.t2.durationMs, 500);
  assert.equal(v.tools.t2.output, "kept");
  // done for an unknown tool is a no-op
  assert.equal(reduce(v, { sessionId: "s", type: "tool.done", toolCallId: "ghost", ok: true }, 2600), v);
});

test("tool.call/done: sink-stamped at beats frameTime on both ends (issue #142 audit)", () => {
  /* with the sink stamping `at`, a tool's span is server-clock on both
     ends — startedAt and the derived durationMs alike — so the timeline
     never mixes client and server clocks inside one span */
  let v = emptyView();
  const S = 1_760_000_000_000; // ms-scale server stamp (toMs treats <1e12 as seconds)
  v = reduce(v, { sessionId: "s", type: "tool.call", toolCallId: "t1", name: "bash", args: {}, at: S }, 1000);
  assert.equal(v.tools.t1.startedAt, S);
  v = reduce(v, { sessionId: "s", type: "tool.done", toolCallId: "t1", ok: true, at: S + 345 }, 1001);
  assert.equal(v.tools.t1.durationMs, 345, "derived from the pair of stamps, not the frame clock");
  // explicit harness-reported durationMs still wins over any derivation
  v = reduce(v, { sessionId: "s", type: "tool.call", toolCallId: "t2", name: "read", args: {}, at: S }, 1002);
  v = reduce(v, { sessionId: "s", type: "tool.done", toolCallId: "t2", ok: true, durationMs: 7, at: S + 345 }, 1003);
  assert.equal(v.tools.t2.durationMs, 7);
});

test("perm.request/resolve: card lifecycle, pending queue, unknown resolve is harmless", () => {
  let v = emptyView();
  v = reduce(v, { sessionId: "s", type: "perm.request", requestId: "r1", tool: "bash", reason: "needs network", options: ["allow", "deny"] }, T0);
  const p = v.perms.r1;
  assert.equal(p.tool, "bash");
  assert.equal(p.reason, "needs network");
  assert.deepEqual(p.options, ["allow", "deny"]);
  assert.equal(p.choice, undefined);
  assert.deepEqual(v.pending, ["r1"]);
  assert.deepEqual(v.items, [{ kind: "perm", id: "r1" }]);
  // duplicate request ignored
  assert.equal(reduce(v, { sessionId: "s", type: "perm.request", requestId: "r1", tool: "bash", reason: "x", options: [] }, T0), v);
  // resolve records the choice and dequeues
  v = reduce(v, { sessionId: "s", type: "perm.resolve", requestId: "r1", choice: "allow" }, T0);
  assert.equal(v.perms.r1.choice, "allow");
  assert.deepEqual(v.pending, []);
  // resolve for an unknown request: perms object untouched (same reference), no crash
  const v2 = reduce(v, { sessionId: "s", type: "perm.resolve", requestId: "ghost", choice: "allow" }, T0);
  assert.equal(v2.perms, v.perms);
  assert.deepEqual(v2.pending, []);
});

test("llm.call.start/done: 1-based rows, metrics, retryOf, tool attribution to open call", () => {
  let v = emptyView();
  v = reduce(v, { sessionId: "s", type: "llm.call.start", callId: "c1", model: "gpt-x", at: 1_700_000_000 }, T0);
  v = reduce(v, { sessionId: "s", type: "llm.call.start", callId: "c2", model: "gpt-x", at: 1_700_000_001 }, T0);
  assert.deepEqual(v.callOrder, ["c1", "c2"]);
  assert.equal(v.calls.c1.index, 1); // 1-based
  assert.equal(v.calls.c2.index, 2);
  assert.equal(v.calls.c1.done, false);
  assert.equal(v.calls.c1.at, 1_700_000_000_000); // at via toMs
  // duplicate start ignored
  assert.equal(reduce(v, { sessionId: "s", type: "llm.call.start", callId: "c1", model: "gpt-x", at: 9 }, T0), v);
  // tool.call without callId attributes to the most recent OPEN call (c2)
  v = reduce(v, { sessionId: "s", type: "tool.call", toolCallId: "t1", name: "bash", args: {} }, T0);
  assert.deepEqual(v.calls.c2.tools, ["t1"]);
  assert.deepEqual(v.calls.c1.tools, []);
  // tool.call with an explicit known callId attributes there instead
  v = reduce(v, { sessionId: "s", type: "tool.call", toolCallId: "t2", name: "read", args: {}, callId: "c1" }, T0);
  assert.deepEqual(v.calls.c1.tools, ["t2"]);
  // tool.call with an UNKNOWN callId falls back to the most recent open call
  v = reduce(v, { sessionId: "s", type: "tool.call", toolCallId: "t3", name: "read", args: {}, callId: "nope" }, T0);
  assert.deepEqual(v.calls.c2.tools, ["t1", "t3"]);
  // done records metrics + retry linkage
  v = reduce(v, {
    sessionId: "s", type: "llm.call.done", callId: "c2", status: 200, latencyMs: 1234,
    tokensIn: 10, tokensOut: 20, costUsd: 0.01, cacheRead: 5, cacheWrite: 6, retryOf: "c1",
  }, T0);
  const c2 = v.calls.c2;
  assert.equal(c2.done, true);
  assert.equal(c2.status, 200);
  assert.equal(c2.latencyMs, 1234);
  assert.equal(c2.tokensIn, 10);
  assert.equal(c2.tokensOut, 20);
  assert.equal(c2.costUsd, 0.01);
  assert.equal(c2.cacheRead, 5);
  assert.equal(c2.cacheWrite, 6);
  assert.equal(c2.retryOf, "c1");
  // done for an unknown call is a no-op
  assert.equal(reduce(v, { sessionId: "s", type: "llm.call.done", callId: "ghost", status: 0, latencyMs: 0 }, T0), v);
});

test("ctx.usage: recorded on the view, history capped at 200 points", () => {
  let v = emptyView();
  v = reduce(v, { sessionId: "s", type: "ctx.usage", used: 100, total: 200, by: { system: 50 } }, 777);
  assert.deepEqual(v.ctx, { used: 100, total: 200, by: { system: 50 } });
  assert.deepEqual(v.ctxHistory, [{ t: 777, used: 100, total: 200 }]);
  for (let i = 0; i < 210; i++) v = reduce(v, { sessionId: "s", type: "ctx.usage", used: i, total: 1000 }, 1000 + i);
  assert.equal(v.ctxHistory.length, 200); // slice(-200)
  assert.equal(v.ctxHistory[199].used, 209); // newest kept
  assert.equal(v.ctxHistory[0].used, 10); // oldest dropped
  assert.equal(v.ctx?.used, 209);
});

test("session.state: only stateDetail lands on the view; unknown event types pass through untouched", () => {
  let v = emptyView();
  v = reduce(v, { sessionId: "s", type: "session.state", state: "running", detail: "thinking hard" }, T0);
  assert.equal(v.stateDetail, "thinking hard");
  // note: reduce() does NOT store the session state enum on the view — only its
  // detail string (live state is applied to the session row by Store.onFrame)
  assert.equal("state" in v, false);
  const v2 = reduce(v, { sessionId: "s", type: "totally.unknown" } as unknown as ProtoEvent, T0);
  assert.equal(v2, v); // default branch: same reference, no crash
});

test("items order: msgs, tools and perms appear in arrival order", () => {
  let v = emptyView();
  v = reduce(v, { sessionId: "s", type: "msg.start", messageId: "m1", role: "user", at: 0 }, 1);
  v = reduce(v, { sessionId: "s", type: "tool.call", toolCallId: "t1", name: "bash", args: {} }, 2);
  v = reduce(v, { sessionId: "s", type: "perm.request", requestId: "r1", tool: "bash", reason: "r", options: [] }, 3);
  v = reduce(v, { sessionId: "s", type: "msg.chunk", messageId: "m2", text: "hi" }, 4); // implicit message also appends
  v = reduce(v, { sessionId: "s", type: "msg.start", messageId: "m3", role: "assistant", at: 0 }, 5);
  assert.deepEqual(v.items, [
    { kind: "msg", id: "m1" },
    { kind: "tool", id: "t1" },
    { kind: "perm", id: "r1" },
    { kind: "msg", id: "m2" },
    { kind: "msg", id: "m3" },
  ]);
});

test("session.updated patches model/provider in place (model switch reflects immediately)", async () => {
  store.set((s) => ({
    sessions: {
      ...s.sessions,
      "ms-1": {
        id: "ms-1", harness: "pi", title: "t", cwd: "/tmp", model: "m1", provider: "p1",
        state: "idle", created_at: 0, updated_at: 0, live: true,
      } as never,
    },
  }));
  (store as unknown as { onFrame: (f: { seq: number; ev: unknown }) => void }).onFrame({ seq: 10, ev: { type: "session.updated", sessionId: "ms-1", model: "m2", provider: "p2" } as never });
  assert.equal(store.state.sessions["ms-1"].model, "m2");
  assert.equal(store.state.sessions["ms-1"].provider, "p2");
  (store as unknown as { onFrame: (f: { seq: number; ev: unknown }) => void }).onFrame({ seq: 11, ev: { type: "session.updated", sessionId: "ms-1", title: "renamed" } as never });
  assert.equal(store.state.sessions["ms-1"].title, "renamed");
  assert.equal(store.state.sessions["ms-1"].model, "m2", "unrelated updates keep the model");
  delete store.state.sessions["ms-1"];
});

test("session.updated patches labels in place (issue #174: chips repaint live, no reload)", async () => {
  store.set((s) => ({
    sessions: {
      ...s.sessions,
      "lbl-1": {
        id: "lbl-1", harness: "pi", title: "t", cwd: "/tmp",
        state: "idle", created_at: 0, updated_at: 0, live: true, labels: ["old"],
      } as never,
    },
  }));
  const s = store as unknown as { onFrame: (f: { seq: number; ev: unknown }) => void; refreshLabels: () => Promise<void> };
  let registryRefreshes = 0;
  const orig = s.refreshLabels;
  s.refreshLabels = async () => {
    registryRefreshes++;
  };
  try {
    s.onFrame({ seq: 30, ev: { type: "session.updated", sessionId: "lbl-1", labels: ["bug", "ui"] } as never });
    assert.deepEqual(store.state.sessions["lbl-1"].labels, ["bug", "ui"], "the row carries the new set");
    assert.equal(registryRefreshes, 1, "a labels frame refreshes the sidebar filter's registry");
    s.onFrame({ seq: 31, ev: { type: "session.updated", sessionId: "lbl-1", title: "renamed" } as never });
    assert.deepEqual(store.state.sessions["lbl-1"].labels, ["bug", "ui"], "unrelated updates keep the labels");
    assert.equal(registryRefreshes, 1, "and a labels-less frame leaves the registry alone");
  } finally {
    s.refreshLabels = orig;
    delete store.state.sessions["lbl-1"];
  }
});

test("session.updated for an unknown session refreshes the trash list too (restore drops the ghost for every client)", async () => {
  /* restoreSession broadcasts session.updated; only the restoring client
     refreshes its own trash list, so other clients kept the restored session
     as a ghost in "recently deleted" until reload */
  const s = store as unknown as {
    onFrame: (f: { seq: number; ev: unknown }) => void;
    refreshTrash: () => Promise<void>;
    refreshSessionsSoon: () => void;
  };
  let trashRefreshes = 0;
  let sessionRefreshes = 0;
  const origTrash = s.refreshTrash;
  const origSoon = s.refreshSessionsSoon;
  s.refreshTrash = async () => {
    trashRefreshes++;
  };
  s.refreshSessionsSoon = () => {
    sessionRefreshes++;
  };
  try {
    s.onFrame({ seq: 20, ev: { type: "session.updated", sessionId: "restored-1" } as never });
    assert.equal(sessionRefreshes, 1, "an unknown meta still re-lists sessions");
    assert.equal(trashRefreshes, 1, "and the trash list refreshes so the restored ghost disappears");
    /* a plain metadata patch on a known session must NOT hit the trash route */
    store.set((st) => ({
      sessions: {
        ...st.sessions,
        "ms-1": {
          id: "ms-1", harness: "pi", title: "t", cwd: "/tmp", model: "m1", provider: "p1",
          state: "idle", created_at: 0, updated_at: 0, live: true,
        } as never,
      },
    }));
    s.onFrame({ seq: 21, ev: { type: "session.updated", sessionId: "ms-1", title: "x" } as never });
    assert.equal(trashRefreshes, 1, "known-meta updates leave the trash list alone");
    delete store.state.sessions["ms-1"];
  } finally {
    s.refreshTrash = origTrash;
    s.refreshSessionsSoon = origSoon;
  }
});

test("session.updated for an UNKNOWN session (a restore from another device) refreshes sessions AND the trash list", async () => {
  /* regression: a restore broadcasts session.updated; the handler re-listed
     the main sessions but never refreshed the trash, so this device kept the
     restored chat under "recently deleted" until the next deletion event */
  const s = store as unknown as {
    onFrame: (f: { seq: number; ev: unknown }) => void;
    refreshSessionsSoon: () => void;
    refreshTrash: () => Promise<void>;
  };
  let soonCalls = 0;
  let trashCalls = 0;
  s.refreshSessionsSoon = () => {
    soonCalls++;
  };
  s.refreshTrash = () => {
    trashCalls++;
    return Promise.resolve();
  };
  try {
    assert.ok(!store.state.sessions["ghost-restore"], "not a session this device knows");
    s.onFrame({ seq: 20, ev: { type: "session.updated", sessionId: "ghost-restore", title: "back from trash" } as never });
    assert.equal(soonCalls, 1, "re-lists the main sessions so the row appears");
    assert.equal(trashCalls, 1, "and the trash list drops it here too, immediately");
  } finally {
    /* restore the prototype methods (the spies were own properties) */
    delete (s as Record<string, unknown>).refreshSessionsSoon;
    delete (s as Record<string, unknown>).refreshTrash;
  }
});

test("msg.start attachments ride onto the message (transcript chips survive reload); absent stays absent", () => {
  const atts = [{ name: "error.log", path: ".truss-uploads/error.log", size: 1234, mime: "text/plain" }];
  let v = emptyView();
  v = reduce(v, { type: "msg.start", sessionId: "s", messageId: "m1", role: "user", at: 1000, attachments: atts } as never, T0);
  assert.deepEqual(v.msgs["m1"].attachments, atts, "refs on the message");
  v = reduce(v, { type: "msg.chunk", sessionId: "s", messageId: "m1", text: "see attached" } as never, T0 + 1);
  assert.deepEqual(v.msgs["m1"].attachments, atts, "chunks keep them");
  v = reduce(v, { type: "msg.done", sessionId: "s", messageId: "m1" } as never, T0 + 2);
  assert.deepEqual(v.msgs["m1"].attachments, atts, "done keeps them");

  // no attachments -> no field (backward-compat with old event logs)
  let v2 = emptyView();
  v2 = reduce(v2, { type: "msg.start", sessionId: "s", messageId: "m2", role: "user", at: 1000 } as never, T0);
  assert.ok(!("attachments" in v2.msgs["m2"]), "no phantom field on plain messages");
});

/* REGRESSION — developer report on the PR #98 preview: a hermes session
   stuck on "Booting…" forever while the server row already read idle.

   The create POST response is read server-side BEFORE the boot pump sinks
   the first state event, so it always carries state "spawning". A warm
   harness (second hermes session on one process) boots in well under the
   350ms refresh debounce: the live idle frame heals the row via
   refreshSessions, and then the late POST response writes "spawning" back
   over it. No further state events come, so the composer stays blocked on
   Booting forever. The response row must never regress a live state. */
test("createSession: a stale 'spawning' POST row never regresses a live state the bus already applied", async () => {
  const staleRow = {
    id: "boot-race", harness: "hermes", title: "t", cwd: "/tmp",
    state: "spawning", created_at: 0, updated_at: 0,
  };
  store.set((s) => ({
    backend: {
      createSession: async () => ({ session: { ...staleRow } }),
      getEvents: async () => ({ events: [] }),
    } as never,
    sessions: {
      ...s.sessions,
      /* the live idle frame won the race into the row (via refreshSessions)
         before the POST response landed */
      "boot-race": { ...staleRow, state: "idle", live: true } as never,
    },
  }));
  await store.createSession({ harness: "hermes", cwd: "/tmp" } as never);
  assert.equal(
    store.state.sessions["boot-race"].state,
    "idle",
    "the response's stale 'spawning' must not clobber the live idle — today it wedges the session on Booting forever",
  );
  delete store.state.sessions["boot-race"];
  delete store.state.views["boot-race"];
});

test("createSession: with no live state applied yet, the response row lands as-is (Booting shows until boot)", async () => {
  store.set(() => ({
    backend: {
      createSession: async () => ({
        session: { id: "boot-fresh", harness: "dsh", title: "t", cwd: "/tmp", state: "spawning", created_at: 0, updated_at: 0 },
      }),
      getEvents: async () => ({ events: [] }),
    } as never,
  }));
  await store.createSession({ harness: "dsh", cwd: "/tmp" } as never);
  assert.equal(store.state.sessions["boot-fresh"].state, "spawning", "a cold boot still shows Booting");
  delete store.state.sessions["boot-fresh"];
  delete store.state.views["boot-fresh"];
});

test("models.updated refetches harnesses (a probe-filled catalog reaches open pickers live)", async () => {
  /* issue #101: a lazy adapter (hermes/dsh) probes on a fresh server and
     announces the filled catalog with models.updated — the store must refetch
     /api/harnesses so an open New Session dialog sees the models appear */
  const s = store as unknown as {
    onFrame: (f: { seq: number; ev: unknown }) => void;
    refreshHarnesses: () => Promise<void>;
  };
  let refetches = 0;
  s.refreshHarnesses = async () => {
    refetches++;
  };
  try {
    s.onFrame({ seq: 30, ev: { type: "models.updated", sessionId: "", harness: "hermes" } as never });
    assert.equal(refetches, 1);
    s.onFrame({ seq: 31, ev: { type: "models.updated", sessionId: "", harness: "dsh" } as never });
    assert.equal(refetches, 2);
  } finally {
    delete (s as Record<string, unknown>).refreshHarnesses;
  }
});

test("probeEmptyCatalogs asks only when a probeable harness has an empty catalog (boot-time probe)", async () => {
  /* fired from store.init so the probe's ~1s overlaps page load instead of
     the first dialog open (developer feedback on the PR #104 preview) */
  const s = store as unknown as {
    probeEmptyCatalogs: () => Promise<void>;
    refreshHarnesses: (probe?: boolean) => Promise<void>;
  };
  const calls: (boolean | undefined)[] = [];
  s.refreshHarnesses = async (probe?: boolean) => {
    calls.push(probe);
  };
  try {
    /* probeable + empty → ask */
    store.set({ harnesses: [{ id: "hermes", capabilities: {} as never, probeable: true }], models: [] } as never);
    await s.probeEmptyCatalogs();
    assert.deepEqual(calls, [true]);

    /* catalog present → no ask */
    store.set({ models: [{ harness: "hermes", provider: "p", model: "m", label: "l" }] } as never);
    await s.probeEmptyCatalogs();
    assert.equal(calls.length, 1);

    /* empty but NOT probeable (pi without models.json, remote adapters) → no ask */
    store.set({ harnesses: [{ id: "pi", capabilities: {} as never }], models: [] } as never);
    await s.probeEmptyCatalogs();
    assert.equal(calls.length, 1);
  } finally {
    delete (s as Record<string, unknown>).refreshHarnesses;
    store.set({ harnesses: [], models: [] });
  }
});

test("init fires the boot-time catalog probe once the harness list lands", async () => {
  /* pins the headline wiring of the boot-probe commit: deleting the
     probeEmptyCatalogs() call in init must fail here, not ship green and
     silently regress to "picker visibly empty until the first dialog open"
     (audit round 5) */
  const s = store as unknown as {
    init: (b: unknown) => Promise<void>;
    probeEmptyCatalogs: () => Promise<void>;
  };
  let probes = 0;
  s.probeEmptyCatalogs = async () => {
    probes++;
  };
  const be = {
    connectEvents: () => () => {},
    harnesses: async () => ({ harnesses: [], models: [] }),
    agents: async () => ({ agents: [] }),
    listSessions: async () => ({ sessions: [] }),
    listTerminals: async () => ({ terminals: [] }),
    todos: async () => ({ todos: [] }),
    feed: async () => ({ items: [] }),
    hosts: async () => ({ hosts: [] }),
  };
  /* init writes ~10 state slices (agents, sessions/order, terminals, todos,
     feed, hosts, loaded flags…) — snapshot the whole state and restore it,
     so a test appended after this one inherits nothing (audit: the sibling
     tests reset every slice they touch; this one must too) */
  const before = { ...store.state };
  try {
    await s.init(be);
    assert.equal(probes, 1, "init asks once after the boot fetch");
  } finally {
    delete (s as Record<string, unknown>).probeEmptyCatalogs;
    store.set(before);
  }
});

test("pair.changed refetches hosts; only a fresh ask toasts (the Allow click must not sit unseen)", () => {
  /* issue #111 review: the auto-pair installer announces the device and the
     server broadcasts pair.changed — the store must refetch /api/hosts (the
     pendingPair list the sidebar renders) immediately, and toast only on
     "requested" (a decision is the operator's own act — no toast) */
  const s = store as unknown as {
    onFrame: (f: { seq: number; ev: unknown }) => void;
    refreshHosts: () => Promise<void>;
  };
  let refetches = 0;
  const toastsBefore = store.state.toasts.length;
  s.refreshHosts = async () => {
    refetches++;
  };
  try {
    s.onFrame({ seq: 40, ev: { type: "pair.changed", sessionId: "", event: "requested", request: { id: "x", hostname: "macmini", os: "macos", expiresAt: 0 } } as never });
    assert.equal(refetches, 1, "the pending list refetches the moment a device asks");
    assert.equal(store.state.toasts.length, toastsBefore + 1, "and the ask toasts");
    s.onFrame({ seq: 41, ev: { type: "pair.changed", sessionId: "", event: "resolved", request: { id: "x", hostname: "macmini", os: "macos", expiresAt: 0 } } as never });
    assert.equal(refetches, 2, "a decision refetches too (the row disappears)");
    assert.equal(store.state.toasts.length, toastsBefore + 1, "but only the ask toasts");
  } finally {
    delete (s as Record<string, unknown>).refreshHosts;
  }
});
