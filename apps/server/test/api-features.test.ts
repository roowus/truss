import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bootServer, waitFor, type TestServer } from "./server-harness.js";

/**
 * FEATURE REST ENDPOINTS against the real booted server — one pass over every
 * non-session surface: todos (+agent ownership over MCP), feed, task board,
 * hosts (token lifecycle over a real WS), layout, practices, files, git,
 * skills, metrics/net/catalog, credentials.
 *
 * Notes on scope discovered while writing this (see the final report):
 *  - there is NO DELETE /api/todos/:id — "dropped" status is the soft delete
 *  - there is NO PATCH /api/hosts/:id — labels are fixed at mint time
 *  - there is NO POST /api/feed — cards arrive via MCP post_feed / autoposters
 *  - PUT /api/layout rejects garbage with 200 {ok:false}, not a 400
 *  - POST /api/feed/:id/share mutates sharedWith BEFORE the chat prompt, so a
 *    share to a dead session 400s but still records the share
 *  - approving a todo access request does NOT settle the request's feed card
 *  - credential keys are masked at the API (hasKey only) but stored PLAINTEXT
 *    in the owner-only config file — "write-only", not hashed
 */

type Ev = Record<string, any>;

let srv: TestServer;

/** the harness's fake HOME (set by bootServer before src modules load) */
const HOME = () => process.env.HOME!;

const api = (path: string, init?: RequestInit) =>
  fetch(`${srv.base}${path}`, init).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const H = { "content-type": "application/json" };
const post = (p: string, b?: unknown) => api(p, { method: "POST", headers: H, body: JSON.stringify(b ?? {}) });
const patch = (p: string, b: unknown) => api(p, { method: "PATCH", headers: H, body: JSON.stringify(b) });
const put = (p: string, b: unknown) => api(p, { method: "PUT", headers: H, body: JSON.stringify(b) });
const del = (p: string) => api(p, { method: "DELETE" });

/** JSON-RPC tools/call against the per-session truss MCP endpoint */
async function mcpCall(sessionId: string, name: string, args: Record<string, unknown>) {
  const r = await post(`/mcp/truss/${sessionId}`, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  assert.equal(r.status, 200, `mcp ${name} transport`);
  const result = r.body?.result;
  const text = String(result?.content?.[0]?.text ?? "");
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* error results are plain text */
  }
  return { isError: result?.isError === true, text, data };
}

async function mkSession(title: string): Promise<string> {
  const c = await post("/api/sessions", { harness: "pi", cwd: "/tmp", title });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  return c.body.session.id as string;
}

const closeSession = (id: string) => del(`/api/sessions/${id}`);

/** refused /agent/connect attempts surface their close code (4403) */
function wsCloseCode(url: string): Promise<number> {
  return new Promise((res) => {
    const ws = new WebSocket(url);
    ws.onclose = (e) => res(e.code);
    ws.onerror = () => {};
  });
}

/** successful agent channel: open + hello (auth happens on the query gate) */
async function agentHandshake(host: string, token: string): Promise<WebSocket> {
  const ws = new WebSocket(`${srv.wsBase}/agent/connect?host=${host}&token=${encodeURIComponent(token)}`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("ws connect failed"));
  });
  ws.send(JSON.stringify({ type: "hello", hostname: host, adapters: [] }));
  return ws;
}

const agentUrl = (host: string, token: string) => `${srv.wsBase}/agent/connect?host=${host}&token=${encodeURIComponent(token)}`;

test.before(async () => {
  srv = await bootServer("features");
});
test.after(async () => {
  await srv?.close();
});

/* ── 1. todos REST ─────────────────────────────────────────────────────── */

test("todos REST: full-field round trip, validation, patch, done/reopen/dropped semantics", async () => {
  /* validation: title required, and whitespace-only doesn't count */
  assert.equal((await post("/api/todos", {})).status, 400);
  const blank = await post("/api/todos", { title: "   " });
  assert.equal(blank.status, 400);
  assert.match(String(blank.body.error), /title required/);

  const full = {
    title: "file the TPS report",
    notes: "**ASAP** — new cover sheet",
    priority: "high",
    deadline: 1893456000000,
    estimate: "S",
    labels: ["ops", "q3"],
    subtasks: [{ id: "s1", text: "cover page", done: false }],
    meta: { ticket: "TPS-9", color: "red" },
  };
  const c = await post("/api/todos", full);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const t0 = c.body.todo;
  assert.equal(typeof t0.id, "string");
  assert.equal(t0.title, full.title);
  assert.equal(t0.notes, full.notes);
  assert.equal(t0.priority, "high");
  assert.equal(t0.deadline, full.deadline);
  assert.equal(t0.estimate, "S");
  assert.deepEqual(t0.labels, ["ops", "q3"]);
  assert.deepEqual(t0.subtasks, [{ id: "s1", text: "cover page", done: false }]);
  assert.deepEqual(t0.meta, { ticket: "TPS-9", color: "red" });
  assert.equal(t0.status, "open");
  assert.equal(t0.createdBy, "user", "REST-created todos are user-owned");
  assert.equal(t0.doneAt, undefined);
  assert.equal(typeof t0.createdAt, "number");

  /* list contains it */
  const list = await api("/api/todos");
  assert.equal(list.status, 200);
  assert.ok(list.body.todos.some((t: Ev) => t.id === t0.id), "listed after create");

  /* patch: partial edit merges — untouched fields persist */
  const p1 = await patch(`/api/todos/${t0.id}`, {
    title: "file the TPS reports",
    priority: "urgent",
    subtasks: [{ id: "s1", text: "cover page", done: true }],
  });
  assert.equal(p1.status, 200);
  assert.equal(p1.body.todo.title, "file the TPS reports");
  assert.equal(p1.body.todo.priority, "urgent");
  assert.deepEqual(p1.body.todo.subtasks, [{ id: "s1", text: "cover page", done: true }]);
  assert.deepEqual(p1.body.todo.meta, { ticket: "TPS-9", color: "red" }, "meta survived a patch that didn't mention it");
  assert.equal(p1.body.todo.deadline, full.deadline);

  /* patch validation */
  assert.equal((await patch(`/api/todos/${t0.id}`, { priority: "mega" })).status, 400);
  assert.equal((await patch(`/api/todos/${t0.id}`, { status: "maybe" })).status, 400);
  assert.equal((await patch(`/api/todos/nope-nope`, { title: "x" })).status, 400);

  /* done stamps doneAt */
  const done = await patch(`/api/todos/${t0.id}`, { status: "done" });
  assert.equal(done.status, 200);
  assert.equal(done.body.todo.status, "done");
  assert.equal(typeof done.body.todo.doneAt, "number", "doneAt stamped");

  /* reopen clears the stamp */
  const reopened = await patch(`/api/todos/${t0.id}`, { status: "open" });
  assert.equal(reopened.body.todo.status, "open");
  assert.equal(reopened.body.todo.doneAt, undefined, "reopen clears doneAt");

  /* "dropped" is the delete semantics — there is no DELETE route (404) */
  const dropped = await patch(`/api/todos/${t0.id}`, { status: "dropped" });
  assert.equal(dropped.body.todo.status, "dropped");
  assert.equal((await del(`/api/todos/${t0.id}`)).status, 404, "no DELETE /api/todos/:id route exists");
});

/* ── 2. todo ownership: agent files via MCP, foreign edit needs approval ── */

test("todo access flow over MCP+REST: approval card (deduped), approve, deny, approve-lifts-deny", async () => {
  const A = await mkSession("owner-A");
  const B = await mkSession("intruder-B");
  const C = await mkSession("denied-C");
  try {
    /* agent A files a todo through the MCP surface (the only way a todo gets
       a session owner) — it auto-posts a feed card dedupe-keyed todo:<id> */
    const filed = await mcpCall(A, "file_todo", {
      title: "approve the deploy",
      notes: "check the canary first",
      priority: "high",
      labels: ["release"],
      meta: { env: "prod" },
    });
    assert.equal(filed.isError, false, filed.text);
    const todo = filed.data;
    assert.equal(todo.sessionId, A, "owned by the calling session");
    assert.equal(todo.createdBy, "agent");
    assert.equal(todo.priority, "high");
    assert.deepEqual(todo.labels, ["release"]);

    const feedCard = await waitFor(async () => {
      const f = await api("/api/feed");
      return f.body.items.find((i: Ev) => i.data?.todoId === todo.id && !i.data?.accessRequest) ?? null;
    }, "todo card in the feed");
    assert.equal(feedCard.type, "todo");
    assert.equal(feedCard.state, "unread");

    /* foreign session B tries to edit → pending marker + ONE approval card */
    const ask1 = await mcpCall(B, "update_todo", { id: todo.id, status: "done" });
    assert.equal(ask1.isError, false);
    assert.match(String(ask1.data?.pending), /approval requested/);
    const accessCards = async () =>
      (await api("/api/feed")).body.items.filter((i: Ev) => i.data?.accessRequest === true && i.data?.todoId === todo.id && i.data?.requesterId === B);
    await waitFor(async () => ((await accessCards()).length === 1 ? true : null), "approval card posted");
    const ask2 = await mcpCall(B, "update_todo", { id: todo.id, title: "hijacked" });
    assert.match(String(ask2.data?.pending), /approval requested/);
    assert.equal((await accessCards()).length, 1, "repeat request deduped over HTTP (dedupeKey todo-access:<id>:<session>)");

    /* the REST decision route validates its envelope */
    assert.equal((await post(`/api/todos/${todo.id}/access`, {})).status, 400);
    assert.equal((await post(`/api/todos/${todo.id}/access`, { requesterId: B })).status, 400);
    assert.equal((await post(`/api/todos/nope-nope/access`, { requesterId: B, approve: true })).status, 400);

    /* approve → B is a shared editor and its edit lands, stamping doneAt */
    const grant = await post(`/api/todos/${todo.id}/access`, { requesterId: B, approve: true });
    assert.equal(grant.status, 200);
    assert.ok(grant.body.todo.sharedEditors.includes(B));
    const edit = await mcpCall(B, "update_todo", { id: todo.id, status: "done" });
    assert.equal(edit.isError, false, edit.text);
    assert.equal(edit.data.status, "done");
    assert.equal(typeof edit.data.doneAt, "number");

    /* leaving open settles the todo's own feed card (dedupe todo:<id>)… */
    await waitFor(async () => {
      const f = await api("/api/feed?state=done");
      return f.body.items.find((i: Ev) => i.data?.todoId === todo.id && !i.data?.accessRequest) ?? null;
    }, "todo card settled to done");
    /* FIXED (issue #35): answering an access request settles its card —
       resolved asks leave the inbox */
    const leftover = (await accessCards())[0];
    assert.equal(leftover.state, "done", "resolved access card settles to done");

    /* deny flow: C asks, user denies, C is hard-refused from then on */
    const askC = await mcpCall(C, "update_todo", { id: todo.id, title: "nope" });
    assert.match(String(askC.data?.pending), /approval requested/);
    const deny = await post(`/api/todos/${todo.id}/access`, { requesterId: C, approve: false });
    assert.ok(deny.body.todo.deniedEditors.includes(C));
    const again = await mcpCall(C, "update_todo", { id: todo.id, title: "nope" });
    assert.equal(again.isError, true, "denied session gets an MCP error, not a card");
    assert.match(again.text, /denied/);

    /* approve lifts an earlier denial (the guard checks denied first) */
    const forgive = await post(`/api/todos/${todo.id}/access`, { requesterId: C, approve: true });
    assert.ok(forgive.body.todo.sharedEditors.includes(C));
    assert.ok(!forgive.body.todo.deniedEditors.includes(C), "denial lifted on approve");
    const editC = await mcpCall(C, "update_todo", { id: todo.id, title: "C was here" });
    assert.equal(editC.data?.title, "C was here");
  } finally {
    await closeSession(A);
    await closeSession(B);
    await closeSession(C);
  }
});

/* ── 3. feed REST ──────────────────────────────────────────────────────── */

test("feed REST: inbox visibility, state transitions, share into a session chat", async () => {
  const S = await mkSession("feed inbox target");
  try {
    /* no POST /api/feed exists — agents post via MCP post_feed */
    const posted = await mcpCall(S, "post_feed", {
      type: "report",
      title: "raid report",
      body: "found **things**",
      importance: "high",
      data: { seed: 1 },
    });
    assert.equal(posted.isError, false, posted.text);
    const item = posted.data;
    assert.equal(item.type, "report");
    assert.equal(item.sessionId, S);
    assert.equal(item.state, "unread");
    assert.equal(item.importance, "high");

    /* state machine: read → saved → dismissed; default inbox hides dismissed only */
    const read = await post(`/api/feed/${item.id}/state`, { state: "read" });
    assert.equal(read.status, 200);
    assert.equal(read.body.item.state, "read");
    assert.ok((await api("/api/feed")).body.items.some((i: Ev) => i.id === item.id), "read cards stay in the inbox");

    const saved = await post(`/api/feed/${item.id}/state`, { state: "saved" });
    assert.equal(saved.body.item.state, "saved");
    assert.ok((await api("/api/feed?state=saved")).body.items.some((i: Ev) => i.id === item.id), "state filter works");

    assert.equal((await post(`/api/feed/${item.id}/state`, {})).status, 400);
    const badState = await post(`/api/feed/${item.id}/state`, { state: "bogus" });
    assert.equal(badState.status, 400);
    assert.match(String(badState.body.error), /bad state/);
    assert.equal((await post(`/api/feed/nope-nope/state`, { state: "read" })).status, 400);

    /* share: lands on sharedWith AND rides into the target session's chat */
    const share = await post(`/api/feed/${item.id}/share`, { sessionId: S });
    assert.equal(share.status, 200);
    assert.ok(share.body.item.sharedWith.includes(S));
    await waitFor(async () => {
      const r = await api(`/api/sessions/${S}/events`);
      const evs = (r.body?.events ?? []).map((f: Ev) => f.ev);
      return evs.some((e: Ev) => e.type === "msg.chunk" && String(e.text).startsWith("**[shared from your feed]**")) ? evs : null;
    }, "shared card echoed into the session chat");
    /* …and the fake pi answered it (unwrapped — this test runs before the
       practices test writes a global TRUSS.md) */
    await waitFor(async () => {
      const r = await api(`/api/sessions/${S}/events`);
      const evs = (r.body?.events ?? []).map((f: Ev) => f.ev);
      return evs.some((e: Ev) => e.type === "msg.chunk" && String(e.text).includes("REPLY:**[shared from your feed]** raid")) || null;
    }, "assistant replied to the shared card");

    /* sharing twice doesn't duplicate; agents read shared cards via list_feed */
    await post(`/api/feed/${item.id}/share`, { sessionId: S });
    const after2 = await api("/api/feed?state=saved");
    const twice = after2.body.items.find((i: Ev) => i.id === item.id);
    assert.equal(twice.sharedWith.filter((x: string) => x === S).length, 1, "no duplicate share entries");
    const agentView = await mcpCall(S, "list_feed", {});
    assert.ok(agentView.data.some((i: Ev) => i.id === item.id), "agent sees the shared card");

    /* share envelope validation + a non-atomicity surprise */
    assert.equal((await post(`/api/feed/${item.id}/share`, {})).status, 400);
    assert.equal((await post(`/api/feed/nope-nope/share`, { sessionId: S })).status, 400);
    const deadShare = await post(`/api/feed/${item.id}/share`, { sessionId: "bogus-session" });
    assert.equal(deadShare.status, 400, "prompt into a dead session fails");
    const mutated = (await api("/api/feed?state=saved")).body.items.find((i: Ev) => i.id === item.id);
    assert.ok(!mutated.sharedWith.includes("bogus-session"), "FIXED (issue #24): a failed share records nothing — validate both ends, prompt, then record");

    /* dismiss hides from the default inbox, kept under the filter */
    const dis = await post(`/api/feed/${item.id}/state`, { state: "dismissed" });
    assert.equal(dis.body.item.state, "dismissed");
    assert.ok(!(await api("/api/feed")).body.items.some((i: Ev) => i.id === item.id), "dismissed hidden from inbox");
    assert.ok((await api("/api/feed?state=dismissed")).body.items.some((i: Ev) => i.id === item.id), "still listed by state");
  } finally {
    await closeSession(S);
  }
});

/* ── 4. task board REST + a real run through the fake pi ───────────────── */

test("tasks REST: CRUD + run spawns a real session that settles (feed card included)", async () => {
  assert.equal((await post("/api/tasks", { title: "x", cwd: "/tmp" })).status, 400, "harness required");

  const c = await post("/api/tasks", { title: "sweep the yard", prompt: "sweep it well", cwd: "/tmp", harness: "pi" });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const task = c.body.task;
  assert.equal(task.status, "todo");
  assert.equal(task.harness, "pi");
  assert.equal(task.lastRunAt, undefined);
  assert.equal(task.sessionId, undefined);

  assert.ok((await api("/api/tasks")).body.tasks.some((t: Ev) => t.id === task.id), "listed");

  const p = await patch(`/api/tasks/${task.id}`, { title: "sweep the porch", prompt: "sweep the porch well" });
  assert.equal(p.status, 200);
  assert.equal(p.body.task.title, "sweep the porch");
  assert.equal((await patch(`/api/tasks/${task.id}`, { status: "sideways" })).status, 400);
  assert.equal((await patch(`/api/tasks/nope-nope`, { title: "x" })).status, 400);

  /* run: a real session spawns on the pinned harness/cwd and the prompt lands */
  let sid = "";
  try {
    const run = await post(`/api/tasks/${task.id}/run`);
    assert.equal(run.status, 200, JSON.stringify(run.body));
    sid = run.body.session.id;
    assert.equal(run.body.session.harness, "pi");
    assert.equal(run.body.session.cwd, "/tmp");
    assert.equal(run.body.session.project, "taskboard");

    const during = (await api("/api/tasks")).body.tasks.find((t: Ev) => t.id === task.id);
    assert.equal(during.status, "doing", "task marked doing while the run is live");
    assert.equal(during.sessionId, sid);
    assert.equal(typeof during.lastRunAt, "number", "lastRunAt stamped");

    /* the fake pi answers; the prompt round-tripped (raw text in the user echo) */
    const evs = await waitFor(async () => {
      const r = await api(`/api/sessions/${sid}/events`);
      const list = (r.body?.events ?? []).map((f: Ev) => f.ev);
      return list.some((e: Ev) => e.type === "msg.chunk" && String(e.text).includes("REPLY:sweep the porch well")) ? list : null;
    }, "task run reply");
    assert.ok(evs.some((e: Ev) => e.type === "msg.chunk" && e.text === "sweep the porch well"), "user echo carried the raw task prompt");
    assert.ok(evs.some((e: Ev) => e.type === "msg.done"), "turn completed");

    /* settling the run auto-posts a task_run card (feed-autopost, taskRuns source) */
    await waitFor(async () => {
      const f = await api("/api/feed");
      return f.body.items.find((i: Ev) => i.type === "task_run" && i.data?.taskId === task.id) ?? null;
    }, "task_run feed card");
  } finally {
    if (sid) await closeSession(sid);
  }

  /* run failure paths */
  const empty = await post("/api/tasks", { title: "no prompt", prompt: "", cwd: "/tmp", harness: "pi" });
  const noRun = await post(`/api/tasks/${empty.body.task.id}/run`);
  assert.equal(noRun.status, 400);
  assert.match(String(noRun.body.error), /no prompt/);
  assert.equal((await post(`/api/tasks/nope-nope/run`)).status, 400);
  await del(`/api/tasks/${empty.body.task.id}`);

  /* delete */
  assert.equal((await del(`/api/tasks/${task.id}`)).status, 200);
  assert.ok(!(await api("/api/tasks")).body.tasks.some((t: Ev) => t.id === task.id), "gone after delete");
});

/* ── 5. hosts REST + token auth over a real WS ─────────────────────────── */

test("hosts REST: mint (token once) → rotate → revoke → delete, enforced at /agent/connect", async () => {
  assert.equal((await post("/api/hosts", {})).status, 400, "label required");

  const c = await post("/api/hosts", { label: "rig-1", note: "gpu box" });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const host = c.body.host;
  const token = c.body.token as string;
  assert.ok(token.startsWith("truss_agent_"), "plaintext token shown once at mint");
  assert.equal(host.tokenPrefix, `…${token.slice(-6)}`, "only the prefix is stored/shown");
  assert.ok(!("token" in host) && !("tokenHash" in host), "no secret material in the host view");
  assert.equal(host.revoked, false);

  const listed = await api("/api/hosts");
  const row = listed.body.hosts.find((h: Ev) => h.id === host.id);
  assert.ok(row, "listed");
  assert.ok(!JSON.stringify(listed.body).includes(token), "the raw token never appears in list responses");

  /* the minted token connects for real */
  const ws1 = await agentHandshake(host.id, token);
  await waitFor(async () => (await api("/api/hosts")).body.hosts.find((h: Ev) => h.id === host.id)?.online || null, "online after hello");
  ws1.close();

  /* rotate: new plaintext once, old token dies at the WS gate */
  const rot = await post(`/api/hosts/${host.id}/token`);
  assert.equal(rot.status, 200);
  const token2 = rot.body.token as string;
  assert.ok(token2.startsWith("truss_agent_") && token2 !== token);
  assert.equal((await api("/api/hosts")).body.hosts.find((h: Ev) => h.id === host.id)?.tokenPrefix, `…${token2.slice(-6)}`, "prefix updated");
  assert.equal(await wsCloseCode(agentUrl(host.id, token)), 4403, "old token rejected after rotation");
  const ws2 = await agentHandshake(host.id, token2);
  ws2.close();
  assert.equal((await post(`/api/hosts/nope-nope/token`)).status, 400, "rotate unknown host");

  /* revoke → even the fresh token is refused; un-revoke restores */
  assert.equal((await post(`/api/hosts/${host.id}/revoke`, { revoked: true })).status, 200);
  assert.equal((await api("/api/hosts")).body.hosts.find((h: Ev) => h.id === host.id)?.revoked, true);
  assert.equal(await wsCloseCode(agentUrl(host.id, token2)), 4403, "revoked host refused");
  await post(`/api/hosts/${host.id}/revoke`, { revoked: false });
  const ws3 = await agentHandshake(host.id, token2);
  ws3.close();

  /* no label-edit route exists (gap) */
  assert.equal((await patch(`/api/hosts/${host.id}`, { label: "renamed" })).status, 404, "no PATCH /api/hosts/:id");

  /* delete: row gone, token dead */
  assert.equal((await del(`/api/hosts/${host.id}`)).status, 200);
  assert.ok(!(await api("/api/hosts")).body.hosts.some((h: Ev) => h.id === host.id));
  assert.equal(await wsCloseCode(agentUrl(host.id, token2)), 4403, "deleted host's token is dead");
});

/* ── 6. layout round trip ──────────────────────────────────────────────── */

test("layout REST: null default, v2 doc round-trips byte-identical, garbage handling", async () => {
  const empty = await api("/api/layout");
  assert.equal(empty.status, 200);
  assert.equal(empty.body.layout, null, "no layout saved yet");

  /* the version-2 document shape from apps/web/src/lib/desktops.ts parseSaved */
  const doc = {
    version: 2,
    activeId: "main",
    spaces: [
      { id: "main", name: "Main", layout: null },
      { id: "work", name: "Work", layout: null, archived: false },
    ],
    hosts: {},
    settings: {
      density: "compact",
      openMode: "chat",
      terminalFontSize: 14,
      defaultCwd: "/tmp",
      groupMode: "folder",
      feedSources: { permissions: true, workDone: true, taskRuns: true, errors: true, context: true },
    },
  };
  const raw = JSON.stringify(doc);
  const putOk = await put("/api/layout", { layout: raw });
  assert.equal(putOk.status, 200);
  assert.equal(putOk.body.ok, true);

  const again = await api("/api/layout");
  assert.equal(again.body.layout, raw, "returned byte-identical");
  assert.deepEqual(JSON.parse(again.body.layout), doc);

  /* garbage is rejected WITHOUT a 400 — 200 {ok:false} (surprise, asserted as-is)
     and the stored doc survives */
  const junk = await put("/api/layout", { layout: 42 });
  assert.equal(junk.status, 200);
  assert.equal(junk.body.ok, false, "SURPRISE: non-string layout is a 200, not a 400");
  assert.equal((await api("/api/layout")).body.layout, raw, "garbage didn't clobber the doc");

  /* null clears — and reads back as "" (empty string), not null */
  assert.equal((await put("/api/layout", { layout: null })).body.ok, true);
  assert.equal((await api("/api/layout")).body.layout, "", "SURPRISE: cleared layout reads as empty string");

  /* leave a sane doc behind (feedSources defaults matter to the autoposters) */
  await put("/api/layout", { layout: raw });
});

/* ── 7. practices (TRUSS.md) ───────────────────────────────────────────── */

test("practices: default text, PUT round trip, compose walks $HOME→cwd (home root skipped)", async () => {
  const d0 = await api("/api/practices");
  assert.equal(d0.status, 200);
  assert.equal(d0.body.path, "~/.truss/TRUSS.md");
  assert.match(d0.body.text, /# Truss practices/, "built-in default when no file exists");

  const mine = "# house rules\n- be nice\n- tests first";
  assert.equal((await put("/api/practices", { text: mine })).status, 200);
  const d1 = await api("/api/practices");
  assert.equal(d1.body.text, mine, "round trip");
  assert.ok(existsSync(join(HOME(), ".truss", "TRUSS.md")), "written under the fake HOME");

  /* folder walk: proj/TRUSS.md is visible from proj/sub … */
  const proj = mkdtempSync(join(HOME(), "proj-"));
  const sub = join(proj, "sub");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(proj, "TRUSS.md"), "# folder rules here");
  /* …but a loose $HOME/TRUSS.md is deliberately NOT a layer */
  writeFileSync(join(HOME(), "TRUSS.md"), "# stray home file — must be ignored");
  /* project layer: ~/.truss/projects/<project>.md */
  mkdirSync(join(HOME(), ".truss", "projects"), { recursive: true });
  writeFileSync(join(HOME(), ".truss", "projects", "demo.md"), "# project rules here");

  const comp = await api(`/api/practices/compose?cwd=${encodeURIComponent(sub)}&project=demo`);
  assert.equal(comp.status, 200);
  assert.deepEqual(
    comp.body.layers.map((l: Ev) => l.scope),
    ["global", "project", "folder"],
    "layers compose root → leaf",
  );
  const folder = comp.body.layers.find((l: Ev) => l.scope === "folder");
  assert.equal(folder.path, join(proj, "TRUSS.md"));
  assert.ok(!comp.body.layers.some((l: Ev) => l.path === join(HOME(), "TRUSS.md")), "$HOME root itself is skipped");
  assert.match(comp.body.composed, /<!-- global: /);
  assert.match(comp.body.composed, /# folder rules here/);
  assert.ok(
    comp.body.composed.indexOf("# house rules") < comp.body.composed.indexOf("# folder rules here"),
    "global composes before folder",
  );

  /* outside $HOME the folder walk doesn't descend — only global applies */
  const outside = await api(`/api/practices/compose?cwd=${encodeURIComponent("/tmp")}`);
  assert.deepEqual(
    outside.body.layers.map((l: Ev) => l.scope),
    ["global"],
  );
});

/* ── 8. files routes ───────────────────────────────────────────────────── */

test("files REST: list/read/write/create/search, confined to the root", async () => {
  const root = mkdtempSync(join(tmpdir(), "truss-files-"));
  writeFileSync(join(root, "hello.txt"), "hello truss");
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "sub", "nested.md"), "# nested");
  symlinkSync("/etc", join(root, "evil"));

  assert.equal((await api("/api/files")).status, 400, "root required");

  const q = `root=${encodeURIComponent(root)}`;
  const ls = await api(`/api/files?${q}`);
  assert.equal(ls.status, 200);
  const names = ls.body.entries.map((e: Ev) => `${e.kind}:${e.name}`);
  assert.ok(names.includes("file:hello.txt") && names.includes("dir:sub"), "listing sees files and dirs");
  assert.deepEqual(
    ls.body.entries.map((e: Ev) => e.kind),
    ls.body.entries.map((e: Ev) => e.kind).sort((a: string, b: string) => (a === b ? 0 : a === "dir" ? -1 : 1)),
    "dirs sort first",
  );
  const sub1 = await api(`/api/files?${q}&path=sub`);
  assert.deepEqual(sub1.body.entries.map((e: Ev) => e.name), ["nested.md"]);

  const read = await api(`/api/file?${q}&path=hello.txt`);
  assert.equal(read.status, 200);
  assert.equal(read.body.kind, "text");
  assert.equal(read.body.text, "hello truss");
  assert.equal(read.body.truncated, false);
  assert.equal((await api(`/api/file?${q}&path=sub`)).status, 400, "reading a dir is a 400");

  /* write requires an existing file; create makes one */
  assert.equal((await put("/api/file", { root, path: "ghost.txt", content: "x" })).status, 400);
  const wr = await put("/api/file", { root, path: "hello.txt", content: "updated text" });
  assert.equal(wr.status, 200);
  assert.equal(wr.body.text, "updated text");
  assert.equal(readFileSync(join(root, "hello.txt"), "utf8"), "updated text", "disk reflects the write");

  const mk = await post("/api/files/create", { root, path: "newdir/deep.txt", kind: "file" });
  assert.equal(mk.status, 200);
  assert.equal(mk.body.kind, "file");
  assert.ok(existsSync(join(root, "newdir", "deep.txt")));
  assert.equal((await post("/api/files/create", { root, path: "newdir/deep.txt", kind: "file" })).status, 400, "exists → 400");
  assert.equal((await post("/api/files/create", { root, path: "x", kind: "weird" })).status, 400, "bad kind → 400");
  assert.equal((await put("/api/file", { root, path: "newdir/deep.txt", content: "deep" })).status, 200, "created file is writable");

  const found = await api(`/api/files?${q}&q=hell`);
  assert.ok(found.body.entries.some((e: Ev) => e.name === "hello.txt"), "name search");

  /* confinement: lexical AND symlink escapes are refused */
  for (const p of ["../..", "../../etc/passwd"]) {
    const r = await api(`/api/file?${q}&path=${encodeURIComponent(p)}`);
    assert.equal(r.status, 400, p);
    assert.match(String(r.body.error), /escapes the workspace root/);
  }
  const sym = await api(`/api/file?${q}&path=${encodeURIComponent("evil/passwd")}`);
  assert.equal(sym.status, 400);
  assert.match(String(sym.body.error), /symlink/);
  assert.equal((await put("/api/file", { root, path: "../out.txt", content: "x" })).status, 400, "write escape refused");
});

/* ── 9. git routes against a real temp repo ────────────────────────────── */

test("git REST: status/branches/graph/diff/switch on a real repo; graceful non-repo", async () => {
  const repo = mkdtempSync(join(tmpdir(), "truss-git-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" });
  git("init", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git("add", "a.txt");
  git("-c", "user.email=t@e.st", "-c", "user.name=tester", "-c", "commit.gpgsign=false", "commit", "-m", "init");

  const q = `cwd=${encodeURIComponent(repo)}`;
  const st = await api(`/api/git/status?${q}`);
  assert.equal(st.status, 200, JSON.stringify(st.body));
  assert.equal(st.body.isRepo, true);
  assert.equal(st.body.branch, "main");
  assert.deepEqual(st.body.changes, [], "clean tree");

  const br = await api(`/api/git/branches?${q}`);
  assert.equal(br.status, 200);
  assert.equal(br.body.branches.length, 1);
  assert.equal(br.body.branches[0].name, "main");
  assert.equal(br.body.branches[0].current, true);
  assert.equal(br.body.branches[0].last, "init");
  assert.equal(typeof br.body.branches[0].at, "number");

  const gr = await api(`/api/git/graph?${q}`);
  assert.match(gr.body.graph, /init/);

  /* dirty the tree: modified tracked + untracked file */
  writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
  writeFileSync(join(repo, "b.txt"), "new\n");
  const dirty = await api(`/api/git/status?${q}`);
  const change = (p: string) => dirty.body.changes.find((c: Ev) => c.path === p);
  assert.equal(change("a.txt")?.y, "M", "unstaged modification");
  assert.deepEqual([change("b.txt")?.x, change("b.txt")?.y], ["?", "?"], "untracked");

  const diff = await api(`/api/git/diff?${q}&path=a.txt`);
  assert.equal(diff.status, 200);
  assert.match(diff.body.diff, /\+two/, "unstaged diff text");
  git("add", "a.txt");
  const staged = await api(`/api/git/diff?${q}&path=a.txt&staged=1`);
  assert.match(staged.body.diff, /\+two/, "staged diff text");
  assert.equal((await api(`/api/git/diff?${q}&path=a.txt`)).body.diff, "", "nothing left unstaged for a.txt");

  /* switch is the one mutation */
  const sw = await post("/api/git/switch", { cwd: repo, branch: "feature", create: true });
  assert.equal(sw.status, 200);
  assert.equal(sw.body.branch, "feature");
  assert.equal((await api(`/api/git/status?${q}`)).body.branch, "feature");
  assert.equal((await post("/api/git/switch", { cwd: repo, branch: "bad name" })).status, 400, "invalid branch name");
  assert.equal((await post("/api/git/switch", { cwd: repo, branch: "-x" })).status, 400, "flag-looking branch refused");

  /* a non-git dir: status degrades gracefully, the rest 400 */
  const plain = mkdtempSync(join(tmpdir(), "truss-notgit-"));
  const ns = await api(`/api/git/status?cwd=${encodeURIComponent(plain)}`);
  assert.equal(ns.status, 200);
  assert.deepEqual(ns.body, { isRepo: false, changes: [] }, "graceful non-repo status");
  assert.equal((await api(`/api/git/branches?cwd=${encodeURIComponent(plain)}`)).status, 400);
  assert.equal((await api(`/api/git/diff?cwd=${encodeURIComponent(plain)}&path=x`)).status, 400);
  assert.equal((await api(`/api/git/status`)).status, 400, "cwd required");
});

/* ── 10. skills routes against the fake HOME ───────────────────────────── */

test("skills REST: list (user+project scopes), create, disable, trash-to-recoverable", async () => {
  const empty = await api("/api/skills");
  assert.deepEqual(empty.body.skills, [], "no skills in a fresh fake HOME");

  /* a user-scope skill: $HOME/.agents/skills/<name>/SKILL.md */
  const userDir = join(HOME(), ".agents", "skills", "demo-user");
  mkdirSync(userDir, { recursive: true });
  writeFileSync(join(userDir, "SKILL.md"), "---\nname: demo-user\ndescription: user-level demo\n---\n\n# demo\n");
  const listed = await api("/api/skills");
  const userSkill = listed.body.skills.find((s: Ev) => s.name === "demo-user");
  assert.ok(userSkill, "user skill discovered");
  assert.equal(userSkill.scope, "user");
  assert.equal(userSkill.disabled, false);
  assert.equal(userSkill.source, userDir);

  /* disable flips disable-model-invocation in the frontmatter */
  const off = await post("/api/skills/toggle", { source: userDir, disabled: true });
  assert.equal(off.status, 200);
  assert.equal(off.body.skill.disabled, true);
  assert.match(readFileSync(join(userDir, "SKILL.md"), "utf8"), /disable-model-invocation: true/);
  assert.equal((await api("/api/skills")).body.skills.find((s: Ev) => s.name === "demo-user").disabled, true, "persisted");
  await post("/api/skills/toggle", { source: userDir, disabled: false });
  assert.equal((await post("/api/skills/toggle", {})).status, 400);
  assert.equal((await post("/api/skills/toggle", { source: join(HOME(), ".agents", "skills", "ghost"), disabled: true })).status, 400);

  /* create makes a PROJECT skill under <cwd>/.agents/skills/<slug> */
  const cwd = mkdtempSync(join(tmpdir(), "truss-skillproj-"));
  const mk = await post("/api/skills/create", { cwd, name: "My Cool Skill", description: "does x" });
  assert.equal(mk.status, 200, JSON.stringify(mk.body));
  assert.equal(mk.body.skill.name, "my-cool-skill", "slugified");
  assert.equal(mk.body.skill.scope, "project");
  assert.ok(existsSync(join(cwd, ".agents", "skills", "my-cool-skill", "SKILL.md")));
  assert.equal((await post("/api/skills/create", { cwd, name: "My Cool Skill" })).status, 400, "duplicate → 400");
  assert.equal((await post("/api/skills/create", { cwd, name: "!!!" })).status, 400, "unslugifiable name → 400");
  assert.equal((await post("/api/skills/create", { name: "x" })).status, 400, "cwd required");

  /* scoping: project skills only appear when the cwd is given */
  assert.ok(!(await api("/api/skills")).body.skills.some((s: Ev) => s.name === "my-cool-skill"), "project skill hidden without cwd");
  assert.ok((await api(`/api/skills?cwd=${encodeURIComponent(cwd)}`)).body.skills.some((s: Ev) => s.name === "my-cool-skill"), "visible with cwd");

  /* trash is recoverable (rename into .trash, never unlink) */
  const tr = await post("/api/skills/delete", { source: mk.body.skill.source });
  assert.equal(tr.status, 200);
  assert.match(String(tr.body.trashed), /\.trash/);
  assert.ok(existsSync(join(cwd, ".agents", "skills", ".trash", "my-cool-skill", "SKILL.md")), "recoverable in .trash");
  assert.ok(!(await api(`/api/skills?cwd=${encodeURIComponent(cwd)}`)).body.skills.some((s: Ev) => s.name === "my-cool-skill"), "trashed skill not listed");
  assert.equal((await post("/api/skills/delete", { source: mk.body.skill.source })).status, 400, "already gone → 400");
});

/* ── 11. metrics + net + catalog smoke ─────────────────────────────────── */

test("metrics/net/catalog smoke: shapes hold against the loopback box", async () => {
  const m = await api("/api/metrics");
  assert.equal(m.status, 200);
  for (const k of ["at", "host", "cpu", "mem", "net", "disks", "temps", "procs", "pressure", "uptimeSec"]) {
    assert.ok(k in m.body.local.metrics, `local.metrics.${k}`);
  }
  assert.equal(typeof m.body.local.metrics.host.hostname, "string");
  assert.equal(typeof m.body.local.metrics.cpu.usage, "number");
  assert.ok(Array.isArray(m.body.local.history), "rolling history array");
  assert.equal(typeof m.body.agents, "object", "agents map (empty here — no agent connected)");

  const net = await api("/api/net");
  assert.equal(net.status, 200);
  /* SURPRISE: the wizard echoes the CONFIGURED port — TRUSS_PORT=0 under the
     harness, so the echo is 0, not the ephemeral bound port */
  assert.equal(net.body.port, 0);
  assert.equal(typeof net.body.tailscale.installed, "boolean");
  assert.ok(Array.isArray(net.body.lan));
  for (const ip of net.body.lan) assert.match(ip, /^(10\.|192\.168\.|172\.|100\.)/, "lan entries are private v4s");

  const cat = await api("/api/models/catalog");
  assert.equal(cat.status, 200);
  assert.deepEqual(
    cat.body.providers.map((p: Ev) => p.id),
    ["fireworks", "zai", "openrouter", "huggingface"],
    "the four key-proxy routes");
  for (const p of cat.body.providers) {
    assert.equal(typeof p.name, "string");
    assert.equal(typeof p.port, "number");
    assert.ok(Array.isArray(p.models), `${p.id} models array (error string instead when unreachable)`);
    for (const mod of p.models) assert.equal(typeof mod.id, "string");
  }
});

/* ── 12. credentials: write-only keys over HTTP ────────────────────────── */

test("credentials REST: list never leaks keys, upsert stores owner-only plaintext, delete guards last route", async () => {
  /* no config yet → the read error surfaces as a plain 500 (no route-level catch) */
  const noCfg = await api("/api/credentials");
  assert.equal(noCfg.status, 500);
  assert.match(String(noCfg.body?.message), /cannot read/);

  const cfgPath = join(HOME(), ".dsh", "bin", "dsh-key-proxy.json");
  mkdirSync(dirname(cfgPath), { recursive: true });
  writeFileSync(cfgPath, JSON.stringify({ routes: [{ port: 45888, host: "api.example.com", auth: "bearer", key: "supersecret-test-key", description: "seeded" }] }));

  const l1 = await api("/api/credentials");
  assert.equal(l1.status, 200);
  assert.equal(l1.body.service, "dsh-key-proxy.service");
  assert.equal(typeof l1.body.serviceActive, "boolean");
  assert.equal(l1.body.routes.length, 1);
  assert.equal(l1.body.routes[0].hasKey, true);
  assert.ok(!("key" in l1.body.routes[0]), "view carries hasKey only");
  assert.ok(!JSON.stringify(l1.body).includes("supersecret-test-key"), "raw key never leaves the API");

  /* every WRITE below runs with a stubbed-out sudo: this box runs the REAL
     dsh-key-proxy with passwordless sudo, and the module restarts that service
     after each write — a PATH-shadowing failing sudo keeps the test hermetic
     (restart reported as failed, exactly like a sudo-less CI box) */
  const stubBin = mkdtempSync(join(tmpdir(), "truss-nosudo-"));
  writeFileSync(join(stubBin, "sudo"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(stubBin, "sudo"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${stubBin}:${oldPath}`;
  try {
    const up = await post("/api/credentials", { port: 45999, host: "api.internal.example.com", auth: "x-api-key", key: "write-only-key-xyz", description: "fake route" });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.equal(up.body.ok, true);
    assert.equal(up.body.restarted, false, "stubbed sudo → restart reported failed");
    assert.equal(typeof up.body.restartDetail, "string");

    /* same port is an UPSERT (merge by port), not a conflict — the "port
       already in use" validation is unreachable dead code. Omitting the key
       on update keeps the stored one. */
    const up2 = await post("/api/credentials", { port: 45999, host: "api.changed.example.com" });
    assert.equal(up2.status, 200, "SURPRISE: same-port POST updates in place (no 400 conflict)");

    /* validation that actually fires */
    assert.equal((await post("/api/credentials", { port: 46001, host: "api.example.com" })).status, 400, "enabled route needs a key");
    assert.equal((await post("/api/credentials", { port: 0, host: "api.example.com", key: "k" })).status, 400, "port range");

    /* at rest the key is PLAINTEXT in an owner-only file — "write-only" is an
       API-level contract, not hashing (surprise vs the usual wording). The
       upsert preserved the key even though the update omitted it. */
    const onDisk = readFileSync(cfgPath, "utf8");
    assert.ok(onDisk.includes("write-only-key-xyz"), "plaintext at rest, kept across a keyless update");
    assert.ok(onDisk.includes("api.changed.example.com"), "upsert merged the host change");
    assert.equal(statSync(cfgPath).mode & 0o777, 0o600, "owner-only file mode");

    assert.equal((await del("/api/credentials/45999")).status, 200);
    const last = await del("/api/credentials/45888");
    assert.equal(last.status, 400, "the proxy needs at least one route");
    assert.match(String(last.body.error ?? last.body.message), /at least one route/);
  } finally {
    process.env.PATH = oldPath;
  }

  const l2 = await api("/api/credentials");
  assert.equal(l2.body.routes.length, 1, "deleted route gone, seeded route kept");
  assert.ok(!JSON.stringify(l2.body).includes("write-only-key-xyz"), "deleted route's key is gone from the API");
});
