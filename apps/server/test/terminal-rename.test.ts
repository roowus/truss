import { test } from "node:test";
import assert from "node:assert/strict";
import { bootServer, waitFor, type TestServer } from "./server-harness.js";

/* Shell rename (issue #85): the sidebar's row actions include rename, so the
   route must work, validate cleanly, and push a title frame so open tabs
   repaint live. */

let srv: TestServer;

const api = (path: string, init?: RequestInit) =>
  fetch(`${srv.base}${path}`, init).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const rename = (id: string, title: unknown) =>
  api(`/api/terminals/${id}/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });

test.before(async () => {
  srv = await bootServer("terminal-rename");
});
test.after(async () => {
  await srv?.close();
});

test("rename updates the listing and pushes a title frame to attached clients", async () => {
  const c = await api("/api/terminals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: "/tmp", title: "before rename" }),
  });
  const id = c.body.id as string;
  try {
    const ws = new WebSocket(`${srv.wsBase}/api/terminal/${id}/ws`);
    const frames: { type?: string; title?: string }[] = [];
    ws.onmessage = (e) => {
      try {
        frames.push(JSON.parse(String(e.data)));
      } catch {
        /* scrollback */
      }
    };
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error("terminal ws failed"));
    });

    const r = await rename(id, "  deploy box  ");
    assert.equal(r.status, 200);
    assert.equal(r.body.title, "deploy box", "trimmed");

    const list = await api("/api/terminals");
    assert.equal(list.body.terminals.find((t: { id: string }) => t.id === id)?.title, "deploy box", "listing reflects it");

    await waitFor(() => frames.some((f) => f.type === "title" && f.title === "deploy box"), "title frame pushed", 4000);
    ws.close();
  } finally {
    await api(`/api/terminals/${id}`, { method: "DELETE" });
  }
});

test("rename validates: blank and unknown ids reject cleanly and change nothing", async () => {
  const c = await api("/api/terminals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: "/tmp", title: "keep me" }),
  });
  const id = c.body.id as string;
  try {
    for (const bad of ["", "   ", undefined]) {
      const r = await rename(id, bad);
      assert.equal(r.status, 400, `blank title ${JSON.stringify(bad)} rejected`);
    }
    const gone = await rename("nosuch00", "x");
    assert.equal(gone.status, 400, "unknown id rejected");

    const list = await api("/api/terminals");
    assert.equal(list.body.terminals.find((t: { id: string }) => t.id === id)?.title, "keep me", "nothing changed on reject");
  } finally {
    await api(`/api/terminals/${id}`, { method: "DELETE" });
  }
});

test("an exited-but-listed shell stays renamable", async () => {
  const c = await api("/api/terminals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: "/tmp", title: "short lived" }),
  });
  const id = c.body.id as string;
  try {
    /* exit the pty through the client input path, then rename the ghost */
    const ws = new WebSocket(`${srv.wsBase}/api/terminal/${id}/ws`);
    const frames: { type?: string }[] = [];
    ws.onmessage = (e) => {
      try {
        frames.push(JSON.parse(String(e.data)));
      } catch {
        /* scrollback */
      }
    };
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error("terminal ws failed"));
    });
    ws.send(JSON.stringify({ type: "in", data: "exit\n" }));
    await waitFor(() => frames.some((f) => f.type === "exit"), "pty exit", 6000);

    const list = await api("/api/terminals");
    const row = list.body.terminals.find((t: { id: string }) => t.id === id);
    assert.equal(row?.alive, false, "exited but still listed");

    const r = await rename(id, "finished job");
    assert.equal(r.status, 200);
    assert.equal(r.body.title, "finished job");
    ws.close();
  } finally {
    await api(`/api/terminals/${id}`, { method: "DELETE" });
  }
});
