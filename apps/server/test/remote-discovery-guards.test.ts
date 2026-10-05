import { test } from "node:test";
import assert from "node:assert/strict";
import { freshServer, tick } from "./helpers.js";

/* The tunnel-probe guard pins for issue #123, in their OWN file on purpose
   (audit round 2, B1): they rewire remote.ts's module-global registry
   callbacks (wireRemoteRegistry is write-only — there is no getter to
   restore from) to capture registrations and frames. In a file that also
   boots the real server, that clobber would silently break any later
   live-loop test (registerFn left as a no-op → adapters never reach
   sessions.listModels → confusing timeouts far from the cause). One file
   is one process under node --test, so here the clobber dies with the
   process and hurts no one.

   Pinned here: models.result rows are shape-guarded before caching, the
   cache is keyed per adapter (pi@box rows never surface under claude@box),
   and a REAL socket close (agentBye, not the test-facing setter) clears the
   probed catalog. */

test("the probe guards junk rows, keys the cache per adapter, and a real socket close clears it", async () => {
  const { cleanup } = await freshServer("discovery-guards");
  try {
    /* in-process registry drive (no server needed for these pins): capture
       the registered RemoteAdapters and the frames the probes send */
    const remote: any = await import("../src/remote.js");
    const registered = new Map<string, unknown>();
    remote.wireRemoteRegistry({
      register: (id: string, a: unknown) => registered.set(id, a),
      unregister: (id: string) => registered.delete(id),
      sessionGone: () => {},
    });
    const frames: any[] = [];
    const socket = { send: (s: string) => frames.push(JSON.parse(s)), close: () => {}, readyState: 1 };

    /* a TWO-adapter host — the per-adapter keying claim (pi@box rows must
       never surface under claude@box) needs a host that announces both */
    remote.agentHello(
      "box-7",
      "box",
      [
        { id: "pi", capabilities: { permissions: false, subagents: false, streaming: true, queueWhileRunning: true } },
        { id: "claude", capabilities: { permissions: false, subagents: false, streaming: true, queueWhileRunning: true } },
      ],
      socket,
      {},
    );
    const probes = frames.filter((f) => f.type === "models.list");
    assert.equal(probes.length, 2, "hello kicks one catalog probe per adapter");
    for (const p of probes) {
      const rows =
        p.adapterId === "pi"
          ? [{ provider: "p", model: "m", label: "M" }, { provider: "junk" }, "nope", null]
          : [{ provider: "c", model: "cm", label: "CM" }];
      remote.agentFrame("box-7", { type: "models.result", reqId: p.reqId, models: rows });
    }
    await tick(20); // let the probe promises settle into the cache
    assert.deepEqual(remote.hostModels("box-7", "pi"), [{ provider: "p", model: "m", label: "M" }], "rows missing provider/model/label never reach the picker");
    assert.deepEqual(remote.hostModels("box-7", "claude"), [{ provider: "c", model: "cm", label: "CM" }], "cached per adapter — pi's rows never leak into claude@box");
    /* a REAL socket close (not the test-facing setter) is the disconnect
       path the picker relies on */
    remote.agentBye("box-7", socket);
    assert.deepEqual(remote.hostModels("box-7"), [], "a real disconnect drops the probed models");
  } finally {
    cleanup();
  }
});
