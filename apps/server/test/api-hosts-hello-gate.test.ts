import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { bootServer, type TestServer } from "./server-harness.js";

/* The connect-to-hello race (issue #85, audit round 2): an agent that passed
   verifyAgentToken but has not sent hello yet is not in the agents map, so
   dropAgent can't see it. If the host is deleted in that window, the late
   hello must be refused — never registered as a dead host's harnesses. */

let srv: TestServer;

/* one boot per FILE (the harness rule — adapter children hold the loop) */
before(async () => {
  srv = await bootServer("hosts-hello-gate");
});
after(async () => {
  await srv?.close();
});

test("a host deleted between connect and hello never registers", async () => {
  const created = await fetch(`${srv.base}/api/hosts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "race box" }),
  }).then((r) => r.json());
  const { id, token } = { id: created.host.id as string, token: created.token as string };

  /* connect (token verified here) but hold the hello back */
  const ws = new WebSocket(`${srv.wsBase}/agent/connect?host=${id}&token=${encodeURIComponent(token)}`);
  const closed = new Promise<number>((res) => ws.addEventListener("close", (e) => res(e.code)));
  await new Promise<void>((res, rej) => {
    ws.addEventListener("open", () => res(), { once: true });
    ws.addEventListener("error", () => rej(new Error("connect failed")), { once: true });
  });

  /* the delete lands in the window */
  const del = await fetch(`${srv.base}/api/hosts/${id}`, { method: "DELETE" });
  assert.equal(del.status, 200);

  /* the late hello is refused, and nothing registers under the dead id */
  ws.send(JSON.stringify({ type: "hello", hostname: "race-box", adapters: [{ id: "pi", capabilities: {} }] }));
  const code = await Promise.race([closed, new Promise<number>((r) => setTimeout(() => r(-1), 2000))]);
  assert.ok(code > 0, "late hello on a deleted host is closed, not registered");

  const { agents } = await fetch(`${srv.base}/api/agents`).then((r) => r.json());
  assert.ok(!agents.some((a: any) => a.hostId === id), "no harnesses registered for the deleted host");
});

test("a live host's hello in the same window still registers (the gate only blocks the dead)", async () => {
  const created = await fetch(`${srv.base}/api/hosts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "surviving box" }),
  }).then((r) => r.json());
  const { id, token } = { id: created.host.id as string, token: created.token as string };

  const ws = new WebSocket(`${srv.wsBase}/agent/connect?host=${id}&token=${encodeURIComponent(token)}`);
  await new Promise<void>((res, rej) => {
    ws.addEventListener("open", () => res(), { once: true });
    ws.addEventListener("error", () => rej(new Error("connect failed")), { once: true });
  });
  ws.send(JSON.stringify({ type: "hello", hostname: "surviving-box", adapters: [{ id: "pi", capabilities: {} }] }));

  await new Promise((r) => setTimeout(r, 300));
  assert.equal(ws.readyState, WebSocket.OPEN, "socket stays open");
  const { agents } = await fetch(`${srv.base}/api/agents`).then((r) => r.json());
  assert.ok(agents.some((a: any) => a.hostId === id), "registered normally");

  ws.close();
  await fetch(`${srv.base}/api/hosts/${id}`, { method: "DELETE" });
});
