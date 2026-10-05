import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { bootServer, waitFor, type TestServer } from "./server-harness.js";
import { freshServer } from "./helpers.js";

/* SPEC-TESTS for remote model + directory discovery —
   https://github.com/roowus/truss/issues/123
   ("On remote hosts when it's connected it can't connect and use the models
   on that machine — the dropdown just shows default model; and it can't
   auto-find a directory to start a session"). These FAIL on purpose today.

   The root (investigated): the hello frame announces only
   { hostId, hostname, adapters: [{id, capabilities}], sessions, protocol }
   — no models, no home. The server's listModels iterates adapters and a
   RemoteAdapter's listModels has nothing to give (there's no tunnel probe),
   so the picker shows the bare default; and nothing on the server knows a
   good cwd on the remote.

   The contract:

   1. The agent announces discovery at hello: `home` and `suggestedCwds`
      (existing dirs only, home always present, projects-family dirs next).
      Pure pin (packages/node-agent, imported via the metrics precedent):

        suggestCwds({ home, existing }): string[]

      Only dirs in `existing` survive; home leads; ~/projects|code|Developer
      family follows; deduped.

   2. The server stores them on the host record — /api/hosts rows carry
      agent.suggestedCwd (next to agent.hostname) — and the tunnel gains a
      models probe: `models.list { reqId, adapterId }` →
      `models.result { reqId, models }`; the remote adapter's listModels
      answers from the probed cache, so /api/harnesses carries
      `pi@<host>` model rows.

   The live loop below drives a fake agent over a real WebSocket (the
   api-remote-loop pattern). */

interface AgentDiscoveryModule {
  suggestCwds(input: { home: string; existing: string[] }): string[];
}

async function loadAgentDiscovery(): Promise<AgentDiscoveryModule | null> {
  const spec = "../../../packages/node-agent/src/discovery.js"; // variable specifier: typechecks before the module exists
  return import(spec).catch(() => null);
}

test("the agent computes honest directory suggestions (existing dirs only, home first)", async () => {
  const mod = await loadAgentDiscovery();
  assert.ok(mod, "packages/node-agent/src/discovery.ts must export suggestCwds — see issue #123");

  const home = "/Users/rewis";
  const all = mod.suggestCwds({ home, existing: [home, `${home}/projects`, `${home}/code`] });
  assert.equal(all[0], home, "home always leads — the universal fallback");
  assert.ok(all.includes(`${home}/projects`) && all.includes(`${home}/code`), "the projects family follows");
  assert.ok(!all.includes(`${home}/Developer`), "only EXISTING dirs are suggested (the agent checks)");
  assert.deepEqual([...new Set(all)], all, "deduped");
  assert.deepEqual(mod.suggestCwds({ home, existing: [] }), [home], "nothing exists → home alone");
});

/* ── live loop ── */

let srv: TestServer;

async function fakeDiscoveringAgent(host: string, token: string) {
  const ws = new WebSocket(`${srv.wsBase}/agent/connect?host=${host}&token=${encodeURIComponent(token)}`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("ws connect failed"));
  });
  const send = (o: unknown) => ws.send(JSON.stringify(o));
  ws.onmessage = (e: { data: unknown }) => {
    let f: any;
    try {
      f = JSON.parse(String(e.data));
    } catch {
      return;
    }
    if (f.type === "models.list") {
      send({
        type: "models.result",
        reqId: f.reqId,
        adapterId: f.adapterId,
        models: [{ provider: "anthropic", model: "claude-sonnet-4-6", label: "Sonnet 4.6 (on the remote)" }],
      });
    }
  };
  /* Node 22's built-in WebSocket client — the api-remote-loop pattern */
  send({
    type: "hello",
    hostname: "rewissmacbookpro",
    adapters: [{ id: "pi", capabilities: { permissions: false, subagents: false, streaming: true, queueWhileRunning: true } }],
    sessions: [],
    protocol: 2,
    /* the new discovery fields */
    home: "/Users/rewis",
    suggestedCwds: ["/Users/rewis", "/Users/rewis/projects"],
  });
  return { close: () => ws.close() };
}

before(async () => {
  srv = await bootServer("remote-discovery");
  /* the probe trigger in these tests reaches EVERY empty probeable adapter,
     and the real hermes/dsh probe boots a throwaway harness process (their
     probeModels opens a session to harvest its catalog) — swap them for
     inert fakes at the registerAdapter seam (the api-harnesses-probe
     pattern); the assertions below only look at pi@<host> rows */
  const sessionsMod: any = await import("../src/sessions.js");
  for (const id of ["hermes", "dsh"]) {
    sessionsMod.registerAdapter(id, {
      id,
      capabilities: { permissions: false, subagents: false, streaming: true, queueWhileRunning: false },
      async listModels() {
        return [];
      },
      async probeModels() {
        return false;
      },
      async spawn(): Promise<never> {
        throw new Error("not under test");
      },
      send() {},
      interrupt() {},
      async *events() {
        await new Promise(() => {});
        yield undefined as never;
      },
      dispose() {},
    });
  }
});
after(async () => {
  await srv.close();
});

test("a connected host's models reach the picker and its suggested cwd reaches the host record", async () => {
  const created = await fetch(`${srv.base}/api/hosts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "discovery mac" }),
  }).then((r) => r.json());
  const hostId = created.host.id as string;
  const agent = await fakeDiscoveringAgent(hostId, created.token as string);
  try {
    /* trigger the catalog probe the New Session dialog fires — with the
       JSON content-type the route's CSRF gate demands (a bare POST is a
       415 and would exercise nothing; audit round 1, B2) */
    const probe = await fetch(`${srv.base}/api/harnesses/probe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(probe.status, 200, "the dialog's probe ask is accepted");

    /* the picker's catalog must carry the remote's real models */
    await waitFor(async () => {
      const cat = await fetch(`${srv.base}/api/harnesses`).then((r) => r.json());
      return cat.models?.some((m: { harness: string; model: string }) => m.harness === `pi@${hostId}` && m.model === "claude-sonnet-4-6") ?? false;
    }, "remote models in the catalog", 4000);

    /* and the directory suggestion lands on the host record */
    const hosts = await fetch(`${srv.base}/api/hosts`).then((r) => r.json());
    const row = (hosts.hosts ?? hosts).find((h: any) => h.id === hostId);
    assert.ok(row, "the host row exists");
    assert.equal(row.agent?.suggestedCwd, "/Users/rewis/projects", "the remote's own suggestion reaches the server (today the record carries hostname only)");
  } finally {
    agent.close();
  }
});

test("a pre-discovery agent degrades to today's behavior (no suggestion, empty catalog, no crash)", async () => {
  const created = await fetch(`${srv.base}/api/hosts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "old agent box" }),
  }).then((r) => r.json());
  const hostId = created.host.id as string;
  /* hello WITHOUT home/suggestedCwds, and no models.list handler — the
     protocol-2 agent from before issue #123 */
  const ws = new WebSocket(`${srv.wsBase}/agent/connect?host=${hostId}&token=${encodeURIComponent(created.token as string)}`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("ws connect failed"));
  });
  ws.send(
    JSON.stringify({
      type: "hello",
      hostname: "oldbox",
      adapters: [{ id: "pi", capabilities: { permissions: false, subagents: false, streaming: true, queueWhileRunning: true } }],
      sessions: [],
      protocol: 2,
    }),
  );
  try {
    const agent = await waitFor(async () => {
      const hosts = await fetch(`${srv.base}/api/hosts`).then((r) => r.json());
      return (hosts.hosts ?? hosts).find((h: any) => h.id === hostId)?.agent;
    }, "old agent registered", 4000);
    assert.equal(agent.hostname, "oldbox", "connected, as before");
    assert.equal(agent.suggestedCwd, undefined, "no discovery announced → no suggestion, nothing breaks");

    /* the probe ask is answered 200 and the unanswering agent simply leaves
       its harness's catalog empty — the picker shows the bare default, as
       today (hermes/dsh are the inert fakes from before(), so this ask
       never boots a real harness) */
    const probe = await fetch(`${srv.base}/api/harnesses/probe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(probe.status, 200);
    const cat = await probe.json();
    assert.ok(
      !(cat.models ?? []).some((m: { harness: string }) => m.harness === `pi@${hostId}`),
      "an agent that never answers models.list offers nothing, no error",
    );
  } finally {
    ws.close();
  }
});

/* NOTE: the guards/keying/real-close pins live in their own file
   (remote-discovery-guards.test.ts) — they rewire remote.ts's module-global
   registry callbacks for capture, and in THIS file's process (which boots
   the real server) that clobber would silently break any live-loop test
   appended after them (audit round 2, B1). Own file, own process, the
   clobber dies with it. */

test("an offline host's probed models drop out of the catalog (no stale offers)", async () => {
  const { cleanup } = await freshServer("discovery-pure");
  try {
    const remote: any = await import("../src/remote.js");
    assert.equal(typeof remote.setHostModels, "function", "remote.ts must export the models cache — see issue #123");
    remote.setHostModels("box-9", [{ provider: "p", model: "m", label: "M" }]);
    assert.equal(remote.hostModels("box-9").length, 1, "cached while connected");
    remote.setHostModels("box-9", null); // the disconnect path clears it
    assert.deepEqual(remote.hostModels("box-9"), [], "gone when the host leaves — the picker never offers a dead host's models");
  } finally {
    cleanup();
  }
});
