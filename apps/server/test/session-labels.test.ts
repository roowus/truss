import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { bootServer, type TestServer } from "./server-harness.js";

/* SPEC-TESTS for session labels — https://github.com/roowus/truss/issues/174
   ("Besides the project tag, sessions should have labels — like GitHub
   issues/PRs"). These FAIL on purpose today: they pin the contract a fix
   must satisfy.

   Today: sessions carry a single free-text `project` (groups the sidebar).
   Nothing multi-valued, nothing colored, nothing filterable.

   The contract:

     POST /api/sessions/:id/labels  { labels: string[] }   (replace-all)
       → 200; listSessions carries `labels`; a session.updated frame
         broadcasts them live; unknown id 404;
       names cleaned: trimmed, 1–32 chars, blanks dropped, dupes merged,
       case-insensitive dedupe keeping first-seen casing, capped at 8;
     GET /api/labels → the registry (every label in use, for the filter). */

let srv: TestServer;
before(async () => {
  srv = await bootServer("session-labels");
});
after(async () => {
  await srv.close();
});

async function mkChat() {
  const res = await fetch(`${srv.base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ harness: "pi", cwd: "/tmp", title: "label me" }),
  });
  return (await res.json()).session.id as string;
}

test("labels set, persist, broadcast live, and clean themselves", async () => {
  const id = await mkChat();

  const events = new WebSocket(`${srv.wsBase}/events`);
  const seen: any[] = [];
  await new Promise<void>((res, rej) => {
    events.onopen = () => res();
    events.onerror = () => rej(new Error("ws failed"));
  });
  events.onmessage = (e: { data: unknown }) => {
    try {
      seen.push(JSON.parse(String(e.data)));
    } catch {}
  };

  const res = await fetch(`${srv.base}/api/sessions/${id}/labels`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ labels: [" bug ", "Research", "BUG", "", "ui"] }),
  });
  assert.equal(res.status, 200, "the labels route exists (issue #174)");

  const list = await fetch(`${srv.base}/api/sessions`).then((r) => r.json());
  const row = (list.sessions ?? list).find((s: any) => s.id === id);
  assert.deepEqual(row.labels, ["bug", "Research", "ui"], "trimmed, blank-dropped, case-insensitive dedupe keeping first casing");

  await new Promise((r) => setTimeout(r, 300));
  const upd = seen.find((f: any) => (f.ev?.type ?? f.type) === "session.updated" && (f.ev?.sessionId ?? f.sessionId) === id);
  assert.ok(upd, "labels broadcast live (the sidebar filter chips update without a reload)");
  events.close();

  /* replace-all semantics + the cap */
  await fetch(`${srv.base}/api/sessions/${id}/labels`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ labels: Array.from({ length: 15 }, (_, i) => `tag-${i}`) }),
  });
  const list2 = await fetch(`${srv.base}/api/sessions`).then((r) => r.json());
  const row2 = (list2.sessions ?? list2).find((s: any) => s.id === id);
  assert.ok(row2.labels.length <= 8, "capped — a session isn't a sticker wall");
  assert.ok(!row2.labels.includes("bug"), "replace-all: the old set is gone");

  const ghost = await fetch(`${srv.base}/api/sessions/ghost/labels`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ labels: ["x"] }),
  });
  assert.equal(ghost.status, 404, "unknown session");
});

test("GET /api/labels returns the registry for the sidebar filter", async () => {
  const a = await mkChat();
  const b = await mkChat();
  await fetch(`${srv.base}/api/sessions/${a}/labels`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ labels: ["fleet", "ops"] }) });
  await fetch(`${srv.base}/api/sessions/${b}/labels`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ labels: ["ops"] }) });

  const res = await fetch(`${srv.base}/api/labels`);
  assert.equal(res.status, 200, "the registry route exists");
  const body = await res.json();
  const names = (body.labels ?? body).map((l: any) => (typeof l === "string" ? l : l.name));
  assert.ok(names.includes("fleet") && names.includes("ops"), "every label in use");
});
