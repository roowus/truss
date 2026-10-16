import { test } from "node:test";
import assert from "node:assert/strict";

/* issue #216 — the STORE INTEGRATION, not just the outbox state machine.
   Audit B1 was exactly here: the pure outbox was correct, but the store
   called it with `allowQueue: false` for prompts, so a prompt never entered
   the queue and the reconnect replay could never replay one. Unit-testing
   outbox.ts alone could not see that, so this drives the real Store against
   a stub backend and asserts what the store DOES.

   store.ts touches window/document only inside methods, so a minimal global
   stub is enough to import and exercise it. */

const g = globalThis as unknown as Record<string, unknown>;
g.window = g.window ?? { setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval, clearInterval };
g.document = g.document ?? { hidden: false, title: "", addEventListener() {}, removeEventListener() {} };
/* the store coalesces bus frames through rAF; run the callback immediately
   so a test does not have to wait a frame */
g.requestAnimationFrame = g.requestAnimationFrame ?? ((cb: (t: number) => void) => setTimeout(() => cb(0), 0));
g.cancelAnimationFrame = g.cancelAnimationFrame ?? ((id: number) => clearTimeout(id));

async function freshStore() {
  /* a fresh module instance per test: `store` is a module-level singleton and
     the outbox is private state on it */
  const mod = (await import(`../src/lib/store.js?t=${Math.random()}`)) as typeof import("../src/lib/store");
  const calls: { kind: string; body: any; opId?: string }[] = [];
  let failPrompt = 0;
  /* only the three mutating calls matter here; everything init() touches
     just has to resolve so the store reaches a usable state */
  const empty = async () => ({}) as never;
  const be = {
    mode: "live" as const,
    connectEvents: () => () => {},
    harnesses: async () => ({ harnesses: [], models: [] }),
    agents: async () => ({ agents: [] }),
    listSessions: async () => ({ sessions: [] }),
    listTerminals: async () => ({ terminals: [] }),
    todos: async () => ({ todos: [] }),
    feed: async () => ({ items: [] }),
    hosts: async () => ({ hosts: [], pendingPair: [] }),
    trash: async () => ({ sessions: [] }),
    prompt: async (_id: string, text: string, _atts?: unknown, opId?: string) => {
      calls.push({ kind: "prompt", body: { text }, opId });
      if (failPrompt > 0) {
        failPrompt--;
        throw new Error("network down");
      }
      return { ok: true, clientOpId: opId, messageId: "u-1" };
    },
    interrupt: async (_id: string, opId?: string) => {
      calls.push({ kind: "interrupt", body: {}, opId });
      return { ok: true, clientOpId: opId };
    },
    permission: async (_id: string, requestId: string, choice: string, opId?: string) => {
      calls.push({ kind: "perm", body: { requestId, choice }, opId });
      return { ok: true, clientOpId: opId };
    },
    getLayout: empty,
    ...({} as Record<string, unknown>),
  };
  const store = mod.store;
  await store.init(be as never);
  return { store, calls, failPrompt: (n: number) => (failPrompt = n) };
}

test("#216/B1: a prompt LANDS in the outbox (so a reconnect can replay it)", async () => {
  const { store, calls } = await freshStore();
  await store.prompt("s1", "hello");
  assert.equal(calls.length, 1, "the backend was called");
  assert.ok(calls[0]!.opId, "the prompt carried an op id");
});

test("#216/B1: a prompt whose ack is lost stays queued for the replay", async () => {
  const { store, failPrompt } = await freshStore();
  failPrompt(1);
  await assert.rejects(() => store.prompt("s1", "hello"), "the failure still reaches the caller");

  const queued = store.pendingOps();
  assert.equal(queued.length, 1, "the unacked prompt is still queued — this is what B1 broke");
  assert.equal(queued[0]!.kind, "prompt");
  assert.equal(queued[0]!.sessionId, "s1");
});

test("#216: an acked prompt is retired (no phantom replay)", async () => {
  const { store } = await freshStore();
  await store.prompt("s1", "hello");
  assert.equal(store.pendingOps().length, 0, "a clean send leaves nothing queued");
});

test("#216: a replay reuses the SAME op id, so the server dedupes instead of double-sending", async () => {
  const { store, calls, failPrompt } = await freshStore();
  failPrompt(1);
  await assert.rejects(() => store.prompt("s1", "hello"));
  const firstOpId = calls[0]!.opId;

  /* the socket came back: the replay fires the queued entry */
  await store.replayOutbox();
  assert.equal(calls.length, 2, "the queued prompt was resent");
  assert.equal(calls[1]!.opId, firstOpId, "same op id — the whole mechanism");
  assert.equal(store.pendingOps().length, 0, "and it retired on the ack");
});

test("#216: a failed replay KEEPS the entry for the next reconnect (audit B4)", async () => {
  const { store, failPrompt } = await freshStore();
  failPrompt(2); // the first attempt AND the replay both fail
  await assert.rejects(() => store.prompt("s1", "hello"));
  await store.replayOutbox();
  assert.equal(store.pendingOps().length, 1, "not silently dropped — it waits for the next reconnect");
});

test("#216: interrupt and permission are queued too, and retire on ack", async () => {
  const { store, calls } = await freshStore();
  await store.interrupt("s1");
  await store.answer("s1", "req-1", "allow");
  assert.deepEqual(
    calls.map((c) => c.kind),
    ["interrupt", "perm"],
  );
  for (const c of calls) assert.ok(c.opId, `${c.kind} carried an op id`);
  assert.equal(store.pendingOps().length, 0, "both acked and retired");
});

test("#216/B2: the user msg.start frame is a secondary ack", async () => {
  /* audit round 2 B2: the HTTP reply can be the thing that was lost. The
     server echoes the op id on the user's msg.start frame, and that frame
     arriving is proof the server acted — so the entry must retire from it,
     or the next reconnect replays a message already on screen. */
  const { store, failPrompt, calls } = await freshStore();
  failPrompt(1);
  await assert.rejects(() => store.prompt("s1", "hello"));
  const opId = calls[0]!.opId;
  assert.equal(store.pendingOps().length, 1, "queued after the lost ack");

  /* the frame that prompt created arrives over the bus */
  store.onFrame({
    seq: 1,
    ev: { type: "msg.start", sessionId: "s1", messageId: "u-1", role: "user", at: Date.now(), clientOpId: opId },
  } as never);
  assert.equal(store.pendingOps().length, 0, "retired by the frame, not replayed");
});

test("#216: a msg.start frame for an unknown op id changes nothing", async () => {
  const { store } = await freshStore();
  store.onFrame({
    seq: 1,
    ev: { type: "msg.start", sessionId: "s1", messageId: "u-1", role: "user", at: Date.now(), clientOpId: "not-mine" },
  } as never);
  assert.equal(store.pendingOps().length, 0, "no spurious entries");
});

test("#216/B1: repeated replays keep the original age stamp, so the cap can fire", async () => {
  const { store, failPrompt } = await freshStore();
  failPrompt(10); // every attempt fails
  await assert.rejects(() => store.prompt("s1", "hello"));
  const first = store.pendingOps()[0] as unknown as { at: number };
  const stamp = first.at;

  await store.replayOutbox();
  await store.replayOutbox();
  const after = store.pendingOps()[0] as unknown as { at: number };
  assert.equal(after.at, stamp, "the clock did not restart — the cap can still abandon it");
});
