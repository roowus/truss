import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { bootServer, type TestServer } from "./server-harness.js";

/* SPEC-TESTS for renaming a chat (the tab's double-click rename) —
   https://github.com/roowus/truss/issues/141
   ("Rename a shell or a harness chat by double-clicking the tab and typing —
   like workspaces"). These FAIL on purpose today.

   Shells have renameTerminal (issue #29). Sessions have NO rename path at
   all (grep: no session rename anywhere server-side). The contract:

     POST /api/sessions/:id/rename  { title: string }
       → 200, the title persists (listSessions carries it),
         and a session.updated frame broadcasts it live;
       blank/whitespace → 400 (a rename never blanks a title);
       1–64 chars (the terminal rule); unknown id → 404. */

let srv: TestServer;
before(async () => {
  srv = await bootServer("session-rename");
});
after(async () => {
  await srv.close();
});

async function mkChat(title = "rename me") {
  const res = await fetch(`${srv.base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ harness: "pi", cwd: "/tmp", title }),
  });
  assert.equal(res.status, 200);
  return (await res.json()).session.id as string;
}

test("rename persists and broadcasts; blank rejected; unknown 404; the terminal route stands", async () => {
  const id = await mkChat();

  /* watch the bus before the rename */
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

  const renamed = await fetch(`${srv.base}/api/sessions/${id}/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "  the good name  " }),
  });
  assert.equal(renamed.status, 200, "rename lands");

  const list = await fetch(`${srv.base}/api/sessions`).then((r) => r.json());
  const row = (list.sessions ?? list).find((s: any) => s.id === id);
  assert.equal(row.title, "the good name", "persisted, trimmed");

  /* live clients repaint without a reload */
  await new Promise((r) => setTimeout(r, 300));
  const upd = seen.find((f: any) => (f.ev?.type ?? f.type) === "session.updated" && (f.ev?.sessionId ?? f.sessionId) === id);
  assert.ok(upd, "a session.updated frame carries the rename to open clients");
  assert.equal((upd.ev ?? upd).session?.title ?? (upd.ev ?? upd).title, "the good name");
  events.close();

  /* guards */
  const blank = await fetch(`${srv.base}/api/sessions/${id}/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "   " }),
  });
  assert.equal(blank.status, 400, "blank titles are refused (a rename never erases a name)");
  const ghost = await fetch(`${srv.base}/api/sessions/ghost-id/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "x" }),
  });
  assert.equal(ghost.status, 404, "unknown session");

  const long = await fetch(`${srv.base}/api/sessions/${id}/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "x".repeat(300) }),
  });
  assert.equal(long.status, 200, "long titles cap, not reject");
  const afterLong = await fetch(`${srv.base}/api/sessions`).then((r) => r.json());
  assert.ok((afterLong.sessions ?? afterLong).find((s: any) => s.id === id).title.length <= 64, "capped at the terminal rule (64)");
});
