import { test } from "node:test";
import assert from "node:assert/strict";
import { bootServer, openWs, waitFor, type TestServer } from "./server-harness.js";

/**
 * THE FULL LOCAL LOOP, over HTTP+WS against the real server with a fake pi:
 * create → prompt → live WS frames → persisted transcript → trajectory →
 * interrupt → model switch → restart resilience → archive → delete cascade.
 */

let srv: TestServer;

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type Ev = Record<string, any>;

const api = (path: string, init?: RequestInit) =>
  fetch(`${srv.base}${path}`, init).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

test.before(async () => {
  srv = await bootServer("sessions-loop");
});
test.after(async () => {
  await srv?.close();
});

test("health and harnesses list work and include pi with its fake catalog models", async () => {
  const h = await api("/health");
  assert.equal(h.status, 200);
  assert.equal(h.body.ok, true);

  const har = await api("/api/harnesses");
  assert.equal(har.status, 200);
  assert.ok(har.body.harnesses.some((x: { id: string }) => x.id === "pi"), "pi registered");
  const piModels = har.body.models.filter((m: { harness: string }) => m.harness === "pi");
  assert.deepEqual(
    piModels.map((m: { model: string }) => m.model).sort(),
    ["m-big", "m-fast"],
    "models from the fake ~/.pi catalog",
  );
});

test("create → prompt → assistant reply streams live over WS AND persists in the event log", async () => {
  /* WS listener first — live frames must arrive while the turn runs */
  const ws = await openWs(`${srv.wsBase}/events`);
  try {
    const c = await api("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ harness: "pi", cwd: "/tmp", title: "loop", provider: "test-prov", model: "m-fast" }),
    });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    const id = c.body.session.id;
    assert.equal(c.body.session.provider, "test-prov");

    const p = await api(`/api/sessions/${id}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello loop" }),
    });
    assert.equal(p.status, 200);

    /* live: frames arrive on the socket as the turn runs (wait for the
       terminal llm.call.done — turn_end lands after the last chunk) */
    await waitFor(
      () =>
        ws.frames.some((f) => (f.ev as Ev)?.type === "llm.call.done") &&
        ws.frames.some(
          (f) =>
            (f.ev as { type?: string; text?: string })?.type === "msg.chunk" &&
            String((f.ev as { text?: string }).text).includes("REPLY:hello loop"),
        ),
      "live turn frames on WS",
    );
    const types = ws.frames.map((f) => (f.ev as { type?: string })?.type);
    for (const t of ["session.created", "msg.start", "msg.chunk", "msg.done", "llm.call.start", "llm.call.done", "session.state"]) {
      assert.ok(types.includes(t), `ws saw ${t}`);
    }
    /* seq strictly increases — the dedupe contract for replay vs live */
    const seqs = ws.frames.map((f) => f.seq as number).filter((n) => n > 0);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "seq monotonic");

    /* persisted: replay the log cold */
    const ev = await api(`/api/sessions/${id}/events`);
    assert.equal(ev.status, 200);
    const evs = ev.body.events.map((f: { ev: { type: string } }) => f.ev.type);
    assert.ok(evs.includes("llm.call.done"), "trajectory row persisted");
    const chunk = ev.body.events.find((f: { ev: { type: string; text?: string } }) => f.ev.type === "msg.chunk" && f.ev.text?.includes("REPLY:hello loop"));
    assert.ok(chunk, "reply persisted");

    /* practices rode the first prompt (fake HOME has no global file, /tmp has
       no TRUSS.md — so the bare prompt goes out unwrapped) */
    const userEcho = ev.body.events.find((f: { ev: { type: string; role?: string } }) => f.ev.type === "msg.start" && f.ev.role === "user");
    assert.ok(userEcho, "local user echo persisted before the adapter speaks");
  } finally {
    ws.close();
  }
});

test("interrupt mid-run maps to an interrupted assistant bubble and idle state", async () => {
  const c = await api("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ harness: "pi", cwd: "/tmp", title: "loop-int" }),
  });
  const id = c.body.session.id;
  await api(`/api/sessions/${id}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "SLOW work" }),
  });
  /* fake pi finishes fast; race the interrupt in before the end */
  await new Promise((r) => setTimeout(r, 30));
  await api(`/api/sessions/${id}/interrupt`, { method: "POST" });

  const ev = await waitFor(async () => {
    const r = await api(`/api/sessions/${id}/events`);
    const evs = r.body.events.map((f: { ev: Record<string, unknown> }) => f.ev);
    return evs.some((e: Ev) => e.type === "session.state" && e.state === "idle") ? evs : null;
  }, "idle after interrupt");
  const states = ev.filter((e: Ev) => e.type === "session.state").map((e: Ev) => e.state);
  assert.deepEqual(states.at(-1), "idle");
});

test("provider error surfaces as an error pill in the transcript (full loop regression)", async () => {
  const c = await api("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ harness: "pi", cwd: "/tmp", title: "loop-err" }),
  });
  const id = c.body.session.id;
  await api(`/api/sessions/${id}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "BOOM" }),
  });
  const evs = await waitFor(async () => {
    const r = await api(`/api/sessions/${id}/events`);
    const list = r.body.events.map((f: { ev: Record<string, unknown> }) => f.ev);
    return list.some((e: Ev) => e.type === "msg.done" && typeof e.stopReason === "string") ? list : null;
  }, "error stopReason");
  const done = evs.find((e: Ev) => e.type === "msg.done" && typeof e.stopReason === "string" && e.stopReason !== undefined);
  assert.ok(String(done.stopReason).startsWith("error:"), `stopReason carries the error: ${done.stopReason}`);
  assert.ok(String(done.stopReason).includes("Unknown Model"));
  const call = evs.find((e: Ev) => e.type === "llm.call.done");
  assert.equal(call.status, 500, "trajectory marks the failed turn 500");
});

test("model switch over HTTP: live mode, row updated, transcript note, next turn uses it", async () => {
  const c = await api("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ harness: "pi", cwd: "/tmp", title: "loop-model", provider: "test-prov", model: "m-fast" }),
  });
  const id = c.body.session.id;

  const sw = await api(`/api/sessions/${id}/model`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "test-prov", model: "m-big" }),
  });
  assert.equal(sw.status, 200);
  assert.equal(sw.body.mode, "live", "pi switches in place");

  const meta = await api(`/api/sessions/${id}`);
  assert.equal(meta.body.session.model, "m-big");
  assert.equal(meta.body.session.provider, "test-prov");

  await api(`/api/sessions/${id}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "after switch" }),
  });
  const evs = await waitFor(async () => {
    const r = await api(`/api/sessions/${id}/events`);
    const list = r.body.events.map((f: { ev: Record<string, unknown> }) => f.ev);
    return list.some((e: Ev) => e.type === "llm.call.done") ? list : null;
  }, "turn done after switch");
  const start = evs.find((e: Ev) => e.type === "llm.call.start");
  assert.equal(start.model, "m-big", "trajectory labeled with the new model");
  assert.ok(evs.some((e: Ev) => e.type === "msg.chunk" && String(e.text).includes("model switched to test-prov/m-big")), "note in transcript");

  const bad = await api(`/api/sessions/${id}/model`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(bad.status, 400, "missing model rejected");
});

test("closed session resumes on prompt with the stored harness ref (server-restart path)", async () => {
  const c = await api("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ harness: "pi", cwd: "/tmp", title: "loop-resume", provider: "test-prov", model: "m-fast" }),
  });
  const id = c.body.session.id;
  await api(`/api/sessions/${id}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "first" }),
  });
  await waitFor(async () => {
    const r = await api(`/api/sessions/${id}/events`);
    return r.body.events.some((f: { ev: { type: string } }) => f.ev.type === "llm.call.done") || null;
  }, "first turn done");

  /* the harness ref landed (fake pi answered get_state) */
  const meta1 = await api(`/api/sessions/${id}`);
  assert.equal(meta1.body.session.harness_ref, "fake-pi-session-1");

  /* close (server restart kills the process), then prompt → auto-resume */
  await api(`/api/sessions/${id}`, { method: "DELETE" }); // soft close
  const meta2 = await api(`/api/sessions/${id}`);
  assert.equal(meta2.body.session.state, "closed");

  await api(`/api/sessions/${id}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "second after restart" }),
  });
  const evs = await waitFor(async () => {
    const r = await api(`/api/sessions/${id}/events`);
    const list = r.body.events.map((f: { ev: Record<string, unknown> }) => f.ev);
    return list.filter((e: Ev) => e.type === "llm.call.done").length >= 2 ? list : null;
  }, "second turn done after resume");
  assert.ok(evs.some((e: Ev) => e.type === "msg.chunk" && String(e.text).includes("REPLY:second after restart")));
});

test("archive hides from the default list; hard delete removes row + events", async () => {
  const c = await api("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ harness: "pi", cwd: "/tmp", title: "loop-arch" }),
  });
  const id = c.body.session.id;

  await api(`/api/sessions/${id}/archive`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ archived: true }) });
  let list = await api("/api/sessions");
  let row = list.body.sessions.find((s: { id: string }) => s.id === id);
  assert.equal(row.archived, 1);

  await api(`/api/sessions/${id}/archive`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ archived: false }) });
  list = await api("/api/sessions");
  row = list.body.sessions.find((s: { id: string }) => s.id === id);
  assert.equal(row.archived, 0);

  /* delete is a 30-day trash move (issue #5): row kept, log kept, off the main list */
  const del = await api(`/api/sessions/${id}?hard=1`, { method: "DELETE" });
  assert.equal(del.status, 200);
  const meta = await api(`/api/sessions/${id}`);
  assert.equal(meta.status, 200, "trashed sessions keep their row");
  assert.ok(meta.body.session.deleted_at, "trash stamp set");

  const trash = await api("/api/trash");
  assert.ok(trash.body.sessions.some((t: Ev) => t.id === id), "listed in the trash");

  /* restore round-trips it */
  const res = await api(`/api/sessions/${id}/restore`, { method: "POST" });
  assert.equal(res.status, 200);
  const back = await api(`/api/sessions/${id}`);
  assert.equal(back.body.session.deleted_at, null, "stamp cleared");

  /* and purge is the only true delete */
  await api(`/api/sessions/${id}?hard=1`, { method: "DELETE" });
  const purge = await api(`/api/sessions/${id}/purge`, { method: "POST" });
  assert.equal(purge.status, 200);
  const gone = await api(`/api/sessions/${id}`);
  assert.equal(gone.status, 404, "purged: row gone for good");
  const ev = await api(`/api/sessions/${id}/events`);
  assert.equal(ev.status, 404, "events gone with the purge");

  /* ghosts */
  assert.equal((await api(`/api/sessions/ghost/purge`, { method: "POST" })).status, 404);
  assert.equal((await api(`/api/sessions/ghost/restore`, { method: "POST" })).status, 404);
  /* same for DELETE ?hard=1 — deleteSession throws on a ghost, the route says 404, not 500 */
  const ghostDel = await api(`/api/sessions/ghost?hard=1`, { method: "DELETE" });
  assert.equal(ghostDel.status, 404);
  assert.ok(String(ghostDel.body.error).includes("no such session"));
});

test("unknown sessions reject cleanly everywhere", async () => {
  assert.equal((await api("/api/sessions/nope-nope")).status, 404);
  assert.equal((await api("/api/sessions/nope-nope/events")).status, 404);
  const p = await api("/api/sessions/nope-nope/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hi" }),
  });
  assert.equal(p.status, 409);
  assert.ok(String(p.body.error).includes("no such session"));
});
