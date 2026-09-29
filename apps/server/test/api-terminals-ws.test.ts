import { test } from "node:test";
import assert from "node:assert/strict";
import { bootServer, waitFor, type TestServer } from "./server-harness.js";

/* terminals (real node-pty, local shell) + the /events bus heartbeat that
   keeps multi-device sync honest */

let srv: TestServer;

const api = (path: string, init?: RequestInit) =>
  fetch(`${srv.base}${path}`, init).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

test.before(async () => {
  srv = await bootServer("terminals");
});
test.after(async () => {
  await srv?.close();
});

test("create → attach over WS → input echoes real output → close → attach refused", async () => {
  const c = await api("/api/terminals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: "/tmp", title: "loop term" }),
  });
  assert.equal(c.status, 200);
  const id = c.body.id as string;
  assert.ok(id);

  let list = await api("/api/terminals");
  assert.ok(list.body.terminals.some((t: { id: string }) => t.id === id), "listed");

  /* attach and run a command through the pty */
  const ws = new WebSocket(`${srv.wsBase}/api/terminal/${id}/ws`);
  const chunks: string[] = [];
  ws.onmessage = (e) => chunks.push(String(e.data));
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("terminal ws failed"));
  });
  ws.send(JSON.stringify({ type: "in", data: "echo TRUSS_TERM_$((40+2))\n" }));
  await waitFor(() => chunks.join("").includes("TRUSS_TERM_42"), "pty output round trip", 6000);

  ws.close();
  await api(`/api/terminals/${id}`, { method: "DELETE" });
  list = await api("/api/terminals");
  assert.ok(!list.body.terminals.some((t: { id: string }) => t.id === id), "gone from the list");

  /* attaching a dead terminal gets the explicit exit frame, not silence */
  const ws2 = new WebSocket(`${srv.wsBase}/api/terminal/${id}/ws`);
  const frames: string[] = [];
  ws2.onmessage = (e) => frames.push(String(e.data));
  await new Promise<void>((res) => {
    ws2.onclose = () => res();
    ws2.onerror = () => res();
  });
  assert.ok(frames.some((f) => f.includes('"exit"')), "explicit exit frame for a gone terminal");
});

test("the /events bus heartbeat pings within two intervals (multi-device sync lifeline)", { timeout: 40000 }, async () => {
  const ws = new WebSocket(`${srv.wsBase}/events`);
  const pings: number[] = [];
  ws.onmessage = (e) => {
    try {
      const f = JSON.parse(String(e.data));
      if (f.type === "ping") pings.push(1);
    } catch {
      /* frames are fine too */
    }
  };
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("bus ws failed"));
  });
  await waitFor(() => pings.length >= 1, "first heartbeat ping", 17000);
  ws.close();
});

test("bus frames stream with monotonic seq (replay-vs-live dedupe contract)", async () => {
  const ws = new WebSocket(`${srv.wsBase}/events`);
  const seqs: number[] = [];
  ws.onmessage = (e) => {
    const f = JSON.parse(String(e.data));
    if (typeof f.seq === "number" && f.seq > 0) seqs.push(f.seq);
  };
  await new Promise<void>((r) => (ws.onopen = () => r()));

  /* provoke a few events: a session create + delete */
  const c = await api("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ harness: "pi", cwd: "/tmp", title: "bus seq" }),
  });
  const id = c.body.session.id as string;
  await api(`/api/sessions/${id}?hard=1`, { method: "DELETE" });

  await waitFor(() => seqs.length >= 2, "a few bus frames");
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "monotonic");
  ws.close();
});
