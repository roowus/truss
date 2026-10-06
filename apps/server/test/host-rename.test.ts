import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { bootServer, type TestServer } from "./server-harness.js";

/* SPEC-TESTS for renaming a remote host — https://github.com/roowus/truss/issues/147
   ("In the sidebar, sessions AND remote hosts: double-click to rename").
   These FAIL on purpose today.

   Sessions get their rename route in #141; hosts have no label setter at
   all (grep hosts.ts: create/revoke/delete only — the label is immutable
   once minted, and the per-user alias in desktop prefs is the only
   workaround). The contract mirrors the session route:

     POST /api/hosts/:id/rename  { label: string }
       → 200, persists (listHosts carries it), trimmed;
       blank → 400; 1–64 chars; unknown id → 404;
       the agent's identity is untouched (the id never changes). */

let srv: TestServer;
before(async () => {
  srv = await bootServer("host-rename");
});
after(async () => {
  await srv.close();
});

test("rename persists with trim/cap; blank 400; ghost 404; the id never changes", async () => {
  const created = await fetch(`${srv.base}/api/hosts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "original name" }),
  }).then((r) => r.json());
  const id = created.host.id as string;

  const res = await fetch(`${srv.base}/api/hosts/${id}/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "  the macbook  " }),
  });
  assert.equal(res.status, 200, "the rename route exists (issue #147)");

  const list = await fetch(`${srv.base}/api/hosts`).then((r) => r.json());
  const row = (list.hosts ?? list).find((h: any) => h.id === id);
  assert.equal(row.label, "the macbook", "persisted, trimmed");
  assert.equal(row.id, id, "the id is the identity — renames never rekey anything (env files on devices keep working)");

  const blank = await fetch(`${srv.base}/api/hosts/${id}/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "   " }),
  });
  assert.equal(blank.status, 400, "blank labels refused");

  const ghost = await fetch(`${srv.base}/api/hosts/ghost-host/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "x" }),
  });
  assert.equal(ghost.status, 404, "unknown host");

  const long = await fetch(`${srv.base}/api/hosts/${id}/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "x".repeat(200) }),
  });
  assert.equal(long.status, 200, "long labels cap");
  const after2 = await fetch(`${srv.base}/api/hosts`).then((r) => r.json());
  assert.ok((after2.hosts ?? after2).find((h: any) => h.id === id).label.length <= 64, "capped at 64 (the terminal/session rule)");
});
