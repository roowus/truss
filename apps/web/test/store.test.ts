import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProtoEvent } from "../src/lib/proto";

// store.ts touches `window` at module scope (`(window as any).__truss = store`).
// That is the ONLY browser global referenced at import time (the Store
// constructor itself only builds plain data; requestAnimationFrame/document are
// used inside methods these tests never call), so this one shim is sufficient.
// It must be installed BEFORE the module is imported — hence a dynamic import
// (static imports are hoisted and would evaluate store.ts before the shim).
(globalThis as any).window ??= {};
/* session.updated goes through Store.onFrame (not the pure reduce), which
   schedules notifications via requestAnimationFrame — shim it for those two
   Store-level tests; everything else still uses the pure reduce path */
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
});

test("msg.done: marks done and preserves stopReason verbatim (provider errors survive to the UI pill)", () => {
  let v = emptyView();
  v = reduce(v, { sessionId: "s", type: "msg.start", messageId: "m1", role: "assistant", at: 0 }, T0);
  v = reduce(v, { sessionId: "s", type: "msg.done", messageId: "m1", stopReason: "error: 400 Unknown Model" }, T0);
  const m = v.msgs.m1;
  assert.equal(m.done, true);
  assert.equal(m.stopReason, "error: 400 Unknown Model"); // regression: must not be mangled/dropped
  // msg.done for an unknown message is a no-op (no implicit creation)
  const v2 = reduce(v, { sessionId: "s", type: "msg.done", messageId: "ghost", stopReason: "x" }, T0);
  assert.equal(v2, v);
  assert.equal(v2.msgs.ghost, undefined);
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
