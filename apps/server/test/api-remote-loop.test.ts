import { test } from "node:test";
import assert from "node:assert/strict";
import { bootServer, waitFor, type TestServer } from "./server-harness.js";

/**
 * THE FULL REMOTE LOOP: a fake node-agent over a REAL websocket through
 * /agent/connect — token auth, hello, adapter registration, spawn over the
 * tunnel, events flowing back into the store + broadcast, metrics_req round
 * trip, per-host disconnect cleanup (the agentBye regression), revocation.
 *
 * No real agent process, no paid API: the "agent" is an in-test WS client
 * speaking the tunnel protocol (vendor docs: packages/node-agent).
 */

let srv: TestServer;

const api = (path: string, init?: RequestInit) =>
  fetch(`${srv.base}${path}`, init).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

/** a fake agent connection: answers spawn with ok and streams canned events */
interface FakeAgent {
  ws: WebSocket;
  received: Record<string, unknown>[];
  send: (o: unknown) => void;
  close: () => void;
}

async function connectAgent(host: string, token: string, opts: { adapters?: { id: string }[]; sessions?: string[] } = {}): Promise<FakeAgent> {
  const ws = new WebSocket(`${srv.wsBase}/agent/connect?host=${host}&token=${encodeURIComponent(token)}`);
  const received: Record<string, unknown>[] = [];
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(String(e.data));
      received.push(msg);
      /* the agent side: spawn acks ok, then canned turn events stream back */
      if (msg.type === "spawn") {
        const sid = (msg.opts as { sessionId: string }).sessionId;
        const send = (o: unknown) => ws.send(JSON.stringify(o));
        ws.send(JSON.stringify({ type: "spawned", reqId: msg.reqId, ok: true }));
        setTimeout(() => {
          send({ type: "event", sessionId: sid, ev: { type: "session.state", sessionId: sid, state: "idle" } });
        }, 5);
      }
      if (msg.type === "send") {
        const sid = msg.sessionId as string;
        const send = (o: unknown) => ws.send(JSON.stringify(o));
        setTimeout(() => {
          send({ type: "event", sessionId: sid, ev: { type: "session.state", sessionId: sid, state: "running" } });
          send({ type: "event", sessionId: sid, ev: { type: "msg.start", sessionId: sid, messageId: "ra1", role: "assistant", at: Date.now() } });
          send({ type: "event", sessionId: sid, ev: { type: "msg.chunk", sessionId: sid, messageId: "ra1", text: `remote reply: ${(msg.text as string).slice(0, 30)}` } });
          send({ type: "event", sessionId: sid, ev: { type: "msg.done", sessionId: sid, messageId: "ra1" } });
          send({ type: "event", sessionId: sid, ev: { type: "session.state", sessionId: sid, state: "idle" } });
        }, 10);
      }
      if (msg.type === "metrics_req") {
        ws.send(
          JSON.stringify({
            type: "metrics",
            reqId: msg.reqId,
            m: { at: Date.now(), host: { hostname: `remote-${host}` }, cpu: { usage: 42 }, mem: { total: 100, used: 50 }, net: [], disks: [], temps: [], procs: [], pressure: { cpu: 0, io: 0, mem: 0 }, uptimeSec: 1 },
          }),
        );
      }
    } catch {
      /* ignore non-json */
    }
  };
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("ws connect failed"));
  });
  const send = (o: unknown) => ws.send(JSON.stringify(o));
  send({
    type: "hello",
    hostname: `remote-${host}`,
    adapters: opts.adapters ?? [{ id: "pi", capabilities: { permissions: false, subagents: false, streaming: true, queueWhileRunning: true } }],
    /* protocol-2 reattach handshake (sessions defaults to empty: nothing
       survived a previous connection). Protocol-1 agents are covered by the
       unit pin in remote.test.ts. */
    sessions: opts.sessions ?? [],
    protocol: 2,
  });
  return { ws, received, send, close: () => ws.close() };
}

test.before(async () => {
  srv = await bootServer("remote-loop");
});
test.after(async () => {
  await srv?.close();
});

test("auth: missing/wrong tokens get 4403; shared env token auto-registers under the host's own id", async () => {
  /* no token at all */
  {
    const ws = new WebSocket(`${srv.wsBase}/agent/connect?host=ghost1`);
    const code = await new Promise<number>((res) => {
      ws.onclose = (e) => res(e.code);
      ws.onerror = () => {};
    });
    assert.equal(code, 4403);
  }
  /* wrong token */
  {
    const ws = new WebSocket(`${srv.wsBase}/agent/connect?host=ghost2&token=nope`);
    const code = await new Promise<number>((res) => {
      ws.onclose = (e) => res(e.code);
      ws.onerror = () => {};
    });
    assert.equal(code, 4403);
  }
  /* shared env token works and self-registers */
  const a = await connectAgent("envhost", "test-shared-token");
  await waitFor(async () => (await api("/api/hosts")).body.hosts.some((h: { id: string }) => h.id === "envhost"), "envhost registered");
  const hosts = await api("/api/hosts");
  const row = hosts.body.hosts.find((h: { id: string }) => h.id === "envhost");
  assert.equal(row.online, true, "online while connected");
  assert.equal(hosts.body.hosts.filter((h: { id: string }) => h.id === "envhost").length, 1, "no duplicate rows");
  a.close();
});

test("per-host token from the wizard flow connects; hello registers remote harnesses", async () => {
  const c = await api("/api/hosts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "rig" }) });
  assert.equal(c.status, 200);
  const { id, token } = { id: c.body.host.id as string, token: c.body.token as string };
  assert.ok(token.startsWith("truss_agent_"), "plaintext shown once");

  const a = await connectAgent(id, token);
  await waitFor(async () => {
    const h = await api("/api/harnesses");
    return h.body.harnesses.some((x: { id: string }) => x.id === `pi@${id}`) || null;
  }, `pi@${id} registered`);
  a.close();

  /* after disconnect the harness unregisters and the host shows offline */
  await waitFor(async () => {
    const h = await api("/api/harnesses");
    return !h.body.harnesses.some((x: { id: string }) => x.id === `pi@${id}`) || null;
  }, "unregistered on disconnect");
  const hosts = await api("/api/hosts");
  assert.equal(hosts.body.hosts.find((h: { id: string }) => h.id === id)?.online, false);
});

test("the whole remote session loop: spawn → prompt → events over the tunnel → persisted + broadcast", async () => {
  const c = await api("/api/hosts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "loop rig" }) });
  const hostId = c.body.host.id as string;
  const agent = await connectAgent(hostId, c.body.token);

  /* listen to the app event bus too — remote events must broadcast like local */
  const bus = new WebSocket(`${srv.wsBase}/events`);
  const busFrames: Record<string, unknown>[] = [];
  bus.onmessage = (e) => busFrames.push(JSON.parse(String(e.data)));
  await new Promise<void>((r) => (bus.onopen = () => r()));

  const cs = await api("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ harness: `pi@${hostId}`, cwd: "/remote/dir", title: "remote loop" }),
  });
  assert.equal(cs.status, 200, JSON.stringify(cs.body));
  const sid = cs.body.session.id as string;

  /* the agent got the spawn frame with our session opts */
  await waitFor(() => agent.received.some((m) => m.type === "spawn"), "spawn frame at agent");
  const spawnMsg = agent.received.find((m) => m.type === "spawn") as { opts: { cwd: string } };
  assert.equal(spawnMsg.opts.cwd, "/remote/dir");

  /* prompt → send frame at agent → events back over the tunnel */
  await api(`/api/sessions/${sid}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "across the wire" }),
  });
  await waitFor(() => agent.received.some((m) => m.type === "send" && m.text === "across the wire"), "send frame at agent");

  /* persisted in the server's event log (came back over the tunnel) */
  const evs = await waitFor(async () => {
    const r = await api(`/api/sessions/${sid}/events`);
    const list = (r.body?.events ?? []).map((f: { ev: Record<string, unknown> }) => f.ev);
    return list.some((e: Record<string, unknown>) => e.type === "msg.chunk" && String(e.text).includes("remote reply")) ? list : null;
  }, "remote reply persisted");
  assert.ok(evs.some((e: Record<string, unknown>) => e.type === "session.state" && e.state === "idle"), "remote state transitions persisted");

  /* and broadcast live on the app bus */
  await waitFor(
    () => busFrames.some((f) => (f.ev as Record<string, unknown>)?.type === "msg.chunk" && String((f.ev as { text?: string }).text).includes("remote reply")),
    "remote chunk on the live bus",
  );

  agent.close();
  bus.close();
});

test("metrics: /api/metrics includes the remote host via the tunnel; dead host is null", async () => {
  const c = await api("/api/hosts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "metrics rig" }) });
  const hostId = c.body.host.id as string;
  const agent = await connectAgent(hostId, c.body.token);

  const m = await api("/api/metrics");
  assert.equal(m.status, 200);
  assert.ok(m.body.local?.metrics?.host?.hostname, "local host vitals present");
  const remote = m.body.agents[hostId];
  assert.ok(remote, "remote entry present");
  assert.equal(remote.metrics.cpu.usage, 42, "agent's own numbers came back");
  assert.equal(remote.metrics.host.hostname, `remote-${hostId}`);

  agent.close();
  await new Promise((r) => setTimeout(r, 100));
  const m2 = await api("/api/metrics");
  /* disconnected hosts drop out of the agents map entirely (the registry
     drives the offline chip) — what matters is no stale numbers survive */
  assert.ok(!m2.body.agents[hostId], "disconnected host serves no stale metrics");
});

test("a tunnel blip wipes NOTHING: sessions survive offline, sends fail loudly, reconcile on reconnect", async () => {
  /* issue #100, item 7: every blip used to be total session loss. Now the
     disconnect alone errors nothing — the reattach handshake at the next
     hello decides what actually died on the agent. */
  const mk = async (label: string) => {
    const c = await api("/api/hosts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label }) });
    const agent = await connectAgent(c.body.host.id, c.body.token);
    return { id: c.body.host.id as string, token: c.body.token as string, agent };
  };
  const A = await mk("host A");
  const B = await mk("host B");

  const mkSess = async (hostId: string, title: string) => {
    const r = await api("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ harness: `pi@${hostId}`, cwd: "/tmp", title }),
    });
    assert.equal(r.status, 200, title);
    return r.body.session.id as string;
  };
  const sidA = await mkSess(A.id, "A session");
  const sidB = await mkSess(B.id, "B session");

  /* the blip: A drops. Neither session errors — A's may come back. */
  A.agent.close();
  await waitFor(async () => {
    const h = await api("/api/harnesses");
    return !h.body.harnesses.some((x: { id: string }) => x.id === `pi@${A.id}`) || null;
  }, "A's harness unregistered");
  const aMeta = await api(`/api/sessions/${sidA}`);
  assert.notEqual(aMeta.body.session.state, "error", "a blip must not error the session (issue #100)");
  const bMeta = await api(`/api/sessions/${sidB}`);
  assert.notEqual(bMeta.body.session.state, "error", "B's session survived A's disconnect");

  /* a send into the dead tunnel FAILS LOUDLY (no more ghost turns) */
  const ghost = await api(`/api/sessions/${sidA}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hello void" }),
  });
  assert.equal(ghost.status, 409, "offline send refuses loudly");
  assert.match(String(ghost.body?.error ?? ""), /offline|not delivered/i);
  /* …and the transcript tells the truth too (audit round 5): the persisted
     user bubble gets an explicit failure marker, so a reload never shows an
     unanswered bubble */
  const ghostEvs = await api(`/api/sessions/${sidA}/events`);
  const ghostList = (ghostEvs.body?.events ?? []).map((f: { ev: Record<string, unknown> }) => f.ev);
  assert.ok(
    ghostList.some((e: Record<string, unknown>) => e.type === "msg.chunk" && /not delivered/i.test(String(e.text))),
    "the transcript carries the not-delivered marker next to the bubble",
  );

  /* B is untouched and still works */
  await api(`/api/sessions/${sidB}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "still alive over B" }),
  });
  await waitFor(async () => {
    const r = await api(`/api/sessions/${sidB}/events`);
    const list = (r.body?.events ?? []).map((f: { ev: Record<string, unknown> }) => f.ev);
    return list.some((e: Record<string, unknown>) => e.type === "msg.chunk" && String(e.text).includes("still alive over B")) || null;
  }, "B answers after A died");

  /* A comes back WITHOUT the session (its process restarted — the session
     really is gone): reconcile errors it now, at hello, not at the blip */
  const a2 = await connectAgent(A.id, A.token, { sessions: [] });
  await waitFor(async () => {
    const s = await api(`/api/sessions/${sidA}`);
    return s.body.session.state === "error" || null;
  }, "A's session erroring at reconcile");

  /* audit B1 regression: a prompt into the reaped session must NOT vanish —
     before forgetLive, the stale live entry answered 200 while the agent
     (which no longer knows the session) no-oped the send: a ghost turn */
  const ghost2 = await api(`/api/sessions/${sidA}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "anyone home?" }),
  });
  assert.equal(ghost2.status, 409, "the lost session refuses loudly (never 200-and-vanish)");
  assert.ok(!a2.received.some((m) => m.type === "send" && m.text === "anyone home?"), "no send frame reached the agent");
  a2.close();

  B.agent.close();
});

test("an agent that kept its sessions across the blip reattaches them — prompts flow again", async () => {
  const c = await api("/api/hosts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "reattach rig" }) });
  const hostId = c.body.host.id as string;
  const token = c.body.token as string;
  const agent = await connectAgent(hostId, token);

  const cs = await api("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ harness: `pi@${hostId}`, cwd: "/tmp", title: "reattach me" }),
  });
  const sid = cs.body.session.id as string;
  await waitFor(() => agent.received.some((m) => m.type === "spawn"), "spawned");

  /* the blip, then the SAME agent process returns with the session alive */
  agent.close();
  await waitFor(async () => !(await api("/api/hosts")).body.hosts.find((h: { id: string }) => h.id === hostId)?.online || null, "offline");
  const agent2 = await connectAgent(hostId, token, { sessions: [sid] });
  await waitFor(async () => (await api("/api/hosts")).body.hosts.find((h: { id: string }) => h.id === hostId)?.online || null, "back online");

  const meta = await api(`/api/sessions/${sid}`);
  assert.notEqual(meta.body.session.state, "error", "reattached, not errored");

  /* and the tunnel carries prompts to it again (no respawn — the agent gets
     a send frame for the session it kept) */
  await api(`/api/sessions/${sid}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "after the blip" }),
  });
  await waitFor(() => agent2.received.some((m) => m.type === "send" && m.text === "after the blip"), "send frame at the reattached agent");
  assert.ok(!agent2.received.some((m) => m.type === "spawn"), "no respawn — the harness kept running");

  agent2.close();
});

test("the server tells a reattached agent to dispose sessions it forgot", async () => {
  /* disposed server-side while the agent was away: the harness process would
     leak on the remote without the reconcile's dispose frame */
  const c = await api("/api/hosts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "leak rig" }) });
  const hostId = c.body.host.id as string;
  const token = c.body.token as string;
  const agent = await connectAgent(hostId, token);
  const cs = await api("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ harness: `pi@${hostId}`, cwd: "/tmp", title: "doomed" }),
  });
  const sid = cs.body.session.id as string;
  await waitFor(() => agent.received.some((m) => m.type === "spawn"), "spawned");

  agent.close();
  await waitFor(async () => !(await api("/api/hosts")).body.hosts.find((h: { id: string }) => h.id === hostId)?.online || null, "offline");
  const del = await api(`/api/sessions/${sid}`, { method: "DELETE" }); // closed server-side mid-blip
  assert.equal(del.status, 200, "the mid-blip close lands");
  const agent2 = await connectAgent(hostId, token, { sessions: [sid] });
  await waitFor(() => agent2.received.some((m) => m.type === "dispose" && m.sessionId === sid), "dispose frame for the forgotten session");
  agent2.close();
});

test("revoking a host kills its channel and future connects get 4403", async () => {
  const c = await api("/api/hosts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "revoked rig" }) });
  const hostId = c.body.host.id as string;
  const token = c.body.token as string;

  const a1 = await connectAgent(hostId, token);
  await waitFor(async () => (await api("/api/hosts")).body.hosts.find((h: { id: string }) => h.id === hostId)?.online || null, "online");

  await api(`/api/hosts/${hostId}/revoke`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revoked: true }) });

  /* audit B4 pin: revoke drops the LIVE channel itself (issue #100 item 11)
     — the test does not close the socket; the server must */
  await waitFor(async () => !(await api("/api/hosts")).body.hosts.find((h: { id: string }) => h.id === hostId)?.online || null, "server dropped the live channel on revoke");

  /* a NEW connect must be refused */
  a1.close();
  await new Promise((r) => setTimeout(r, 50));
  const ws = new WebSocket(`${srv.wsBase}/agent/connect?host=${hostId}&token=${encodeURIComponent(token)}`);
  const code = await new Promise<number>((res) => {
    ws.onclose = (e) => res(e.code);
    ws.onerror = () => {};
  });
  assert.equal(code, 4403, "revoked token refused");

  /* even the shared env token can't resurrect a revoked host */
  const ws2 = new WebSocket(`${srv.wsBase}/agent/connect?host=${hostId}&token=test-shared-token`);
  const code2 = await new Promise<number>((res) => {
    ws2.onclose = (e) => res(e.code);
    ws2.onerror = () => {};
  });
  assert.equal(code2, 4403, "env token cannot bypass revocation");
});

test("rotating a host's token drops its live channel too (audit B4, item 11)", async () => {
  const c = await api("/api/hosts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "rotate rig" }) });
  const hostId = c.body.host.id as string;
  const a1 = await connectAgent(hostId, c.body.token);
  await waitFor(async () => (await api("/api/hosts")).body.hosts.find((h: { id: string }) => h.id === hostId)?.online || null, "online");

  const rot = await api(`/api/hosts/${hostId}/token`, { method: "POST" });
  assert.equal(rot.status, 200, "rotate lands");

  /* the test never closes the socket — the server must (the old token died) */
  await waitFor(async () => !(await api("/api/hosts")).body.hosts.find((h: { id: string }) => h.id === hostId)?.online || null, "server dropped the live channel on rotate");
  a1.close();
});

test("protocol-2 auth: the token rides the Authorization header, not the query (audit B3, item 13)", async () => {
  /* node's built-in WebSocket can't set headers — ws can (devDependency) */
  const { default: WS } = await import("ws");
  const c = await api("/api/hosts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "header rig" }) });
  const hostId = c.body.host.id as string;
  const token = c.body.token as string;

  const ws = new WS(`${srv.wsBase}/agent/connect?host=${hostId}`, { headers: { authorization: `Bearer ${token}` } });
  await new Promise<void>((res, rej) => {
    ws.on("open", () => res());
    ws.on("error", rej);
  });
  ws.send(JSON.stringify({ type: "hello", hostname: "header-host", adapters: [], protocol: 2, sessions: [] }));
  await waitFor(async () => (await api("/api/hosts")).body.hosts.find((h: { id: string }) => h.id === hostId)?.online || null, "header-auth hello registered");
  ws.close();

  /* a WRONG bearer must not pass even with a valid query token absent */
  const bad = new WS(`${srv.wsBase}/agent/connect?host=${hostId}`, { headers: { authorization: "Bearer nope" } });
  const code = await new Promise<number>((res) => {
    bad.on("close", (c2) => res(c2));
    bad.on("error", () => {});
  });
  assert.equal(code, 4403, "bad bearer refused");
});

test("agent hello and bye broadcast agents.changed (issue #100 manual test: open clients were rendering a stale roster)", async () => {
  const bus = new WebSocket(`${srv.wsBase}/events`);
  const frames: Record<string, unknown>[] = [];
  bus.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
  await new Promise<void>((r) => (bus.onopen = () => r()));

  const c = await api("/api/hosts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "announce rig" }) });
  const agent = await connectAgent(c.body.host.id, c.body.token);
  await waitFor(() => frames.some((f) => (f.ev as Record<string, unknown>)?.type === "agents.changed") || null, "hello announced on the bus");

  const afterHello = frames.length;
  agent.close();
  await waitFor(() => frames.slice(afterHello).some((f) => (f.ev as Record<string, unknown>)?.type === "agents.changed") || null, "bye announced on the bus");
  bus.close();
});
