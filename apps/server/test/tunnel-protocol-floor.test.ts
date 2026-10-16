import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { bootServer, type TestServer } from "./server-harness.js";
import { TUNNEL_CLOSE, TUNNEL_PROTOCOL } from "@truss/proto";

/* The tunnel protocol floor (issue #217). Three behaviors, one file:
   - an OLDER agent is accepted and its host marked `outdated` (never
     hard-blocked — installed agents never auto-update, so a hard floor here
     would break every one of them on a server upgrade);
   - a NEWER agent is refused with a dedicated close code BEFORE it
     registers — a refused agent must leave no hosts-registry entry;
   - an EQUAL agent is unaffected.
   Plus the bundle-hash skew the host detail view displays. */

let srv: TestServer;

before(async () => {
  srv = await bootServer("tunnel-protocol-floor");
});
after(async () => {
  await srv?.close();
});

async function mintHost(label: string) {
  const created = await fetch(`${srv.base}/api/hosts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label }),
  }).then((r) => r.json());
  return { id: created.host.id as string, token: created.token as string };
}

/** connect + hello, with the hello's protocol field fully under test control */
function hello(host: { id: string; token: string }, fields: Record<string, unknown>) {
  const ws = new WebSocket(`${srv.wsBase}/agent/connect?host=${host.id}&token=${encodeURIComponent(host.token)}`);
  const closed = new Promise<{ code: number; reason: string }>((res) => {
    ws.addEventListener("close", (e) => res({ code: (e as CloseEvent).code, reason: (e as CloseEvent).reason }));
    setTimeout(() => res({ code: -1, reason: "timeout" }), 3000);
  });
  const ready = new Promise<void>((res, rej) => {
    ws.addEventListener("open", () => res(), { once: true });
    ws.addEventListener("error", () => rej(new Error("ws connect failed")), { once: true });
  });
  const send = async () => {
    await ready;
    ws.send(JSON.stringify({
      type: "hello",
      hostname: `${host.id}-box`,
      adapters: [{ id: "pi", capabilities: { permissions: false, subagents: false, streaming: true, queueWhileRunning: true } }],
      ...fields,
    }));
  };
  return { ws, closed, ready, send };
}

async function agents() {
  const { agents } = await fetch(`${srv.base}/api/agents`).then((r) => r.json());
  return agents as any[];
}

test("an older agent connects and its host is marked outdated (never blocked)", async () => {
  const host = await mintHost(`older box ${Date.now()}`);
  const older = TUNNEL_PROTOCOL - 1;
  const h = hello(host, { protocol: older, sessions: [], bundleHash: "oldbundle123" });
  await h.send();
  await new Promise((r) => setTimeout(r, 400));

  assert.equal(h.ws.readyState, WebSocket.OPEN, "an older agent is still allowed through");

  const a = (await agents()).find((x) => x.hostId === host.id);
  assert.ok(a, "the older agent registered normally");
  assert.equal(a.protocol, older);
  assert.equal(a.outdated, true, "the host is marked outdated for the banner");

  /* and the same flag reaches the hosts registry the panel reads */
  const { hosts } = await fetch(`${srv.base}/api/hosts`).then((r) => r.json());
  const row = hosts.find((x: any) => x.id === host.id);
  assert.ok(row?.agent, "the host row carries its agent");
  assert.equal(row.agent.outdated, true, "outdated is surfaced on /api/hosts for the banner payload");

  h.ws.close();
  await fetch(`${srv.base}/api/hosts/${host.id}`, { method: "DELETE" });
});

test("a legacy agent that announces NO protocol connects (protocol 1, outdated)", async () => {
  /* the absent-vs-junk asymmetry, end to end: a pre-handshake agent sends no
     `protocol` field at all and MUST keep working. A refactor that lumps
     "absent" in with "junk" fails here. */
  const host = await mintHost(`legacy box ${Date.now()}`);
  const h = hello(host, { sessions: [] }); // no protocol field
  await h.send();
  await new Promise((r) => setTimeout(r, 400));

  assert.equal(h.ws.readyState, WebSocket.OPEN, "a protocol-1 agent still connects");
  const a = (await agents()).find((x) => x.hostId === host.id);
  assert.ok(a, "legacy agent registered");
  assert.equal(a.outdated, true, "legacy counts as older, so it is marked outdated");

  h.ws.close();
  await fetch(`${srv.base}/api/hosts/${host.id}`, { method: "DELETE" });
});

test("a newer agent is refused with the dedicated code and never registers", async () => {
  const host = await mintHost(`newer box ${Date.now()}`);
  const newer = TUNNEL_PROTOCOL + 1;
  const h = hello(host, { protocol: newer, sessions: [] });
  await h.send();

  const closed = await h.closed;
  assert.equal(closed.code, TUNNEL_CLOSE.PROTOCOL_TOO_NEW, "the dedicated close code, not a generic one");
  assert.match(closed.reason, new RegExp(String(newer)), "the reason names the agent's protocol level");

  /* the refusal happens BEFORE registration — the registry must be clean */
  assert.ok(!(await agents()).some((x) => x.hostId === host.id), "a refused agent leaves no agent entry");
  const { hosts } = await fetch(`${srv.base}/api/hosts`).then((r) => r.json());
  const row = hosts.find((x: any) => x.id === host.id);
  assert.equal(row.online, false, "the host is not marked online");
  assert.equal(row.agent, undefined, "and it carries no agent payload");

  await fetch(`${srv.base}/api/hosts/${host.id}`, { method: "DELETE" });
});

test("a hello with a present-but-non-numeric protocol is refused too", async () => {
  const host = await mintHost(`junk box ${Date.now()}`);
  const h = hello(host, { protocol: "three", sessions: [] });
  await h.send();

  const closed = await h.closed;
  assert.equal(closed.code, TUNNEL_CLOSE.PROTOCOL_TOO_NEW, "unreadable protocol is the same class as too-new");
  assert.ok(!(await agents()).some((x) => x.hostId === host.id), "never registered");

  await fetch(`${srv.base}/api/hosts/${host.id}`, { method: "DELETE" });
});

test("an equal-protocol agent is unaffected and not marked outdated", async () => {
  const host = await mintHost(`equal box ${Date.now()}`);
  const h = hello(host, { protocol: TUNNEL_PROTOCOL, sessions: [] });
  await h.send();
  await new Promise((r) => setTimeout(r, 400));

  assert.equal(h.ws.readyState, WebSocket.OPEN);
  const a = (await agents()).find((x) => x.hostId === host.id);
  assert.ok(a, "registered");
  assert.equal(a.protocol, TUNNEL_PROTOCOL);
  assert.notEqual(a.outdated, true, "a matching agent is not outdated");

  h.ws.close();
  await fetch(`${srv.base}/api/hosts/${host.id}`, { method: "DELETE" });
});

test("bundle hash skew is displayed: installed vs the server's current build", async () => {
  const host = await mintHost(`bundle box ${Date.now()}`);
  const h = hello(host, { protocol: TUNNEL_PROTOCOL, sessions: [], bundleHash: "stalebundle7" });
  await h.send();
  await new Promise((r) => setTimeout(r, 400));

  const a = (await agents()).find((x) => x.hostId === host.id);
  assert.ok(a, "registered");
  assert.equal(a.bundleHash, "stalebundle7", "the installed hash is reported for the detail view");
  assert.equal(a.bundleCurrent, false, "and compared against the server's current build");
  assert.ok(a.currentBundleHash, "the server's current hash ships alongside it, so the panel can show both");

  h.ws.close();
  await fetch(`${srv.base}/api/hosts/${host.id}`, { method: "DELETE" });
});
