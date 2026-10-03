import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { bootServer, type TestServer } from "./server-harness.js";

/* SPEC-TESTS for host deletion safety — https://github.com/roowus/truss/issues/85
   ("Allow me to delete hosts and shells from the sidebar"). The sidebar
   affordance needs the route to be safe against its worst case: deleting a
   host whose agent is CONNECTED RIGHT NOW.

   Both pins are RED today (measured against the real booted server):
   - the delete route removes the row, but a repeat delete answers a 500
     instead of a clean 404 — the sidebar's two-click confirm hits exactly
     this on a double-fire;
   - a deleted host's live agent channel must DIE with the row — today the
     socket lives on because tokens are only checked at connect — and a
     reconnect with the dead token must be refused (module-level: hosts.test
     already pins verifyAgentToken; this proves it end to end over the WS). */

let srv: TestServer;

/* one boot per FILE (the harness rule — adapter children hold the loop) */
before(async () => {
  srv = await bootServer("hosts-delete");
});
after(async () => {
  await srv?.close();
});

test("DELETE /api/hosts/:id removes the host; repeat → 404 (the repeat is a 500 today — part of the bug)", async () => {
  {
    const created = await fetch(`${srv.base}/api/hosts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "doomed box" }),
    }).then((r) => r.json());
    assert.ok(created.host?.id, "host minted");

    const del = await fetch(`${srv.base}/api/hosts/${created.host.id}`, { method: "DELETE" });
    assert.equal(del.status, 200, "the sidebar button's route works");

    const list = await fetch(`${srv.base}/api/hosts`).then((r) => r.json());
    assert.ok(!list.hosts.some((h: any) => h.id === created.host.id), "gone from the registry");

    const again = await fetch(`${srv.base}/api/hosts/${created.host.id}`, { method: "DELETE" });
    assert.ok([404, 400].includes(again.status), "repeat delete is a clean 4xx, not a 500");
  }
});

test("deleting a host drops its LIVE agent connection and refuses the dead token", async () => {
  {
    const created = await fetch(`${srv.base}/api/hosts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "live box" }),
    }).then((r) => r.json());
    const { id, token } = { id: created.host.id as string, token: created.token as string };

    /* connect its agent over the real channel */
    const ws = new WebSocket(`${srv.wsBase}/agent/connect?host=${id}&token=${encodeURIComponent(token)}`);
    const closed = new Promise<number>((res) => ws.addEventListener("close", (e) => res(e.code)));
    await new Promise<void>((res, rej) => {
      ws.addEventListener("open", () => res(), { once: true });
      ws.addEventListener("error", () => rej(new Error("connect failed")), { once: true });
    });
    ws.send(JSON.stringify({ type: "hello", hostname: "live-box", adapters: [] }));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(ws.readyState, WebSocket.OPEN, "agent connected");

    await fetch(`${srv.base}/api/hosts/${id}`, { method: "DELETE" });

    const code = await Promise.race([closed, new Promise<number>((r) => setTimeout(() => r(-1), 2000))]);
    assert.ok(code > 0, "the agent channel must close when its host is deleted — today the dead host's socket lives on");

    /* and the dead token can't reconnect */
    const ws2 = new WebSocket(`${srv.wsBase}/agent/connect?host=${id}&token=${encodeURIComponent(token)}`);
    const code2 = await new Promise<number>((res) => {
      ws2.addEventListener("close", (e) => res(e.code));
      setTimeout(() => res(-1), 2000);
    });
    assert.ok(code2 > 0, "reconnect with the deleted host's token is refused");
  }
});
