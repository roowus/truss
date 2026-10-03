import { test } from "node:test";
import assert from "node:assert/strict";
import { bootServer, type TestServer } from "./server-harness.js";

/**
 * Route-level coverage for the three pin endpoints (issue #86, audit round 1
 * B3): the setters are covered by session-pin/terminal-pin spec tests, this
 * file covers the HTTP layer — the 404 mapping for unknown ids and the
 * `pinned !== false` default (a body-less POST pins, never unpins).
 */

let srv: TestServer;

const api = (path: string, init?: RequestInit) =>
  fetch(`${srv.base}${path}`, init).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const post = (path: string, body?: unknown) =>
  api(path, body === undefined ? { method: "POST" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test.before(async () => {
  srv = await bootServer("pin-routes");
});
test.after(async () => {
  await srv?.close();
});

test("POST /api/sessions/:id/pin — toggles, defaults to pin, 404s on unknown", async () => {
  const c = await post("/api/sessions", { harness: "pi", cwd: "/tmp", title: "pin-route" });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const id = c.body.session.id;

  /* body-less POST pins (the archive route's `!== false` default) */
  const p1 = await post(`/api/sessions/${id}/pin`);
  assert.equal(p1.status, 200);
  let list = await api("/api/sessions");
  assert.equal(list.body.sessions.find((s: { id: string }) => s.id === id).pinned, true, "pinned after body-less POST");

  const p2 = await post(`/api/sessions/${id}/pin`, { pinned: false });
  assert.equal(p2.status, 200);
  list = await api("/api/sessions");
  assert.equal(list.body.sessions.find((s: { id: string }) => s.id === id).pinned, false, "explicit false unpins");

  const ghost = await post(`/api/sessions/no-such-session/pin`, { pinned: true });
  assert.equal(ghost.status, 404, "unknown id is a 404, not a 500");
});

test("POST /api/terminals/:id/pin — toggles, list carries it, 404s on unknown", async () => {
  const c = await post("/api/terminals", { cwd: "/tmp", title: "pin-route-shell" });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const id = c.body.id ?? c.body.terminal?.id;
  assert.ok(id, "terminal id in the create response");

  const p1 = await post(`/api/terminals/${id}/pin`, { pinned: true });
  assert.equal(p1.status, 200);
  let list = await api("/api/terminals");
  assert.equal(list.body.terminals.find((t: { id: string }) => t.id === id).pinned, true);

  const p2 = await post(`/api/terminals/${id}/pin`);
  assert.equal((await api("/api/terminals")).body.terminals.find((t: { id: string }) => t.id === id).pinned, true, "body-less POST pins (default)");
  assert.equal(p2.status, 200);

  const ghost = await post(`/api/terminals/ghost/pin`, { pinned: true });
  assert.equal(ghost.status, 404);

  await api(`/api/terminals/${id}`, { method: "DELETE" });
  list = await api("/api/terminals");
  assert.ok(!list.body.terminals.some((t: { id: string }) => t.id === id), "shell cleaned up");
});

test("POST /api/hosts/:id/pin — toggles, list carries it, 404s on unknown", async () => {
  const c = await post("/api/hosts", { label: "pin-route box" });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const id = c.body.host.id;

  const p1 = await post(`/api/hosts/${id}/pin`, { pinned: true });
  assert.equal(p1.status, 200);
  let list = await api("/api/hosts");
  assert.equal(list.body.hosts.find((h: { id: string }) => h.id === id).pinned, true);

  const p2 = await post(`/api/hosts/${id}/pin`, { pinned: false });
  assert.equal(p2.status, 200);
  list = await api("/api/hosts");
  assert.equal(list.body.hosts.find((h: { id: string }) => h.id === id).pinned, false);

  const ghost = await post(`/api/hosts/ghost/pin`, { pinned: true });
  assert.equal(ghost.status, 404);

  await api(`/api/hosts/${id}`, { method: "DELETE" });
});
