import { test } from "node:test";
import assert from "node:assert/strict";
import { bootServer, waitFor, type TestServer } from "./server-harness.js";

/**
 * THE TRUSS MANAGEMENT MCP SERVER, over real HTTP: JSON-RPC 2.0 on
 * POST /mcp/truss (unscoped) and POST /mcp/truss/:sessionId (the caller's
 * session — todo ownership + feed scoping key off it).
 *
 * Envelope facts asserted throughout (from src/mcp-truss.ts):
 *  - success:  { jsonrpc:"2.0", id, result } — tool payloads ride as
 *    result.content[0].text (pretty-printed JSON inside the text part);
 *    there is NO structuredContent.
 *  - tool failure: a SUCCESSFUL rpc response with result.isError === true and
 *    content[0].text = "error: ..." (MCP style), NOT a JSON-RPC error object.
 *  - true JSON-RPC error envelopes only for -32602 (tools/call without a
 *    tool name) and -32601 (unknown method that carried an id).
 *  - notifications (no id) and notifications/initialized get bare 202s.
 *
 * Sessions A and B are real pi sessions (fake pi on PATH) because
 * todos.session_id is a hard FK (db.ts sets PRAGMA foreign_keys = ON), so
 * file_todo only works for session ids that exist in the sessions table.
 */

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
type Ev = Record<string, any>;

let srv: TestServer;
let agentA = ""; /* todo-owning session ids, created in the file_todo test */
let agentB = "";
const spawned = new Set<string>(); /* every session we start, closed in after() */

const api = (path: string, init?: RequestInit) =>
  fetch(`${srv.base}${path}`, init).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const post = (path: string, body: Ev) =>
  api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/* ── MCP plumbing ── */

let rpcId = 0;

/** raw JSON-RPC call; omitId sends a notification (no id member at all) */
async function mcp(method: string, params?: Ev, sessionId?: string, omitId = false) {
  const msg: Ev = { jsonrpc: "2.0", method };
  if (!omitId) msg.id = ++rpcId;
  if (params !== undefined) msg.params = params;
  const r = await fetch(`${srv.base}/mcp/truss${sessionId ? `/${sessionId}` : ""}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(msg),
  });
  const text = await r.text();
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { status: r.status, body, headers: r.headers };
}

/** tools/call with the content envelope unwrapped: data = parsed JSON payload */
async function call(name: string, args: Ev = {}, sessionId?: string) {
  const r = await mcp("tools/call", { name, arguments: args }, sessionId);
  assert.equal(r.status, 200, `${name} http`);
  assert.equal(r.body.jsonrpc, "2.0", `${name} jsonrpc`);
  const res = r.body.result;
  assert.ok(res, `${name} has result (tool errors are isError results, not rpc errors)`);
  const part = res.content?.[0];
  assert.equal(part?.type, "text", `${name} content[0] is a text part`);
  const text = String(part.text);
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  let data: any = undefined;
  try {
    data = JSON.parse(text);
  } catch {
    /* isError payloads are "error: ..." prose, not JSON */
  }
  return { isError: res.isError === true, text, data, raw: res };
}

/** create a real (fake-pi) session over REST and track it for cleanup */
async function mkSession(title: string): Promise<string> {
  const c = await post("/api/sessions", { harness: "pi", cwd: "/tmp", title });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const id = c.body.session.id as string;
  spawned.add(id);
  return id;
}

/** persisted event log of a session, as plain events */
async function eventsOf(id: string): Promise<Ev[]> {
  const r = await api(`/api/sessions/${id}/events`);
  assert.equal(r.status, 200);
  return r.body.events.map((f: { ev: Ev }) => f.ev);
}

test.before(async () => {
  srv = await bootServer("mcp");
});
test.after(async () => {
  /* close every fake pi we spawned so nothing holds the event loop —
     closeSession is idempotent (double-close from srv.close() is safe) */
  for (const id of spawned) {
    try {
      await api(`/api/sessions/${id}`, { method: "DELETE" });
    } catch {
      /* server already going down */
    }
  }
  await srv?.close();
});

test("initialize: protocolVersion, serverInfo, capabilities, instructions (guide only in the fake HOME)", async () => {
  const r = await mcp("initialize");
  assert.equal(r.status, 200);
  assert.equal(r.body.jsonrpc, "2.0");
  assert.equal(typeof r.body.id, "number", "id echoed back");
  const res = r.body.result;
  assert.equal(res.protocolVersion, "2025-03-26");
  assert.deepEqual(res.serverInfo, { name: "truss", version: "0.1.0" });
  assert.deepEqual(res.capabilities, { tools: {} });
  assert.equal(typeof res.instructions, "string");
  assert.ok(res.instructions.includes("file_todo"), "POSTING_GUIDE rides as MCP instructions");

  /* session-scoped initialize: reads the caller's practices — none exist in
     the fake HOME, so instructions stay the bare posting guide even scoped */
  const scoped = await mcp("initialize", undefined, "ghost-no-such-session");
  assert.equal(scoped.status, 200);
  assert.equal(scoped.body.result.protocolVersion, "2025-03-26");
  assert.ok(scoped.body.result.instructions.includes("Truss tools you have"));
});

test("tools/list: every documented tool is present, each with an object inputSchema", async () => {
  const r = await mcp("tools/list");
  assert.equal(r.status, 200);
  const tools = r.body.result.tools as { name: string; description: string; inputSchema: Ev }[];
  assert.ok(Array.isArray(tools));
  const expected = [
    "list_sessions", "get_session", "create_session", "rename_session", "set_project",
    "archive_session", "archive_project", "close_session", "delete_session",
    "send_prompt", "interrupt_session",
    "list_terminals", "create_terminal", "close_terminal",
    "list_harnesses", "list_agents", "get_costs",
    "get_settings", "update_settings", "list_workspaces", "get_layout", "put_layout",
    "run_import_dsh",
    "list_tasks", "create_task", "update_task", "run_task",
    "file_todo", "list_todos", "update_todo", "complete_todo",
    "post_feed", "list_feed",
  ].sort();
  assert.deepEqual(tools.map((t) => t.name).sort(), expected, "33 tools, exact set");
  for (const t of tools) {
    assert.ok(t.description.length > 0, `${t.name} has a description`);
    assert.equal(t.inputSchema?.type, "object", `${t.name} inputSchema is an object schema`);
  }
  /* spot-check the required lists the tool contracts document */
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.deepEqual(byName.file_todo.inputSchema.required, ["title"]);
  assert.deepEqual(byName.complete_todo.inputSchema.required, ["id"]);
  assert.deepEqual(byName.run_task.inputSchema.required, ["id"]);
  assert.deepEqual(byName.create_task.inputSchema.required, ["title", "cwd", "harness"]);
  assert.deepEqual(byName.send_prompt.inputSchema.required, ["id", "text"]);
});

test("file_todo via /mcp/truss/<sid>: owned todo round-trips through REST, auto feed card, postToFeed:false opts out", async () => {
  agentA = await mkSession("mcp-agent-a");
  agentB = await mkSession("mcp-agent-b");

  /* scoped initialize on a real session still resolves (practices composed from cwd) */
  const scoped = await mcp("initialize", undefined, agentA);
  assert.equal(scoped.body.result.protocolVersion, "2025-03-26");

  const deadline = Date.now() + 3_600_000;
  const subtasks = [{ id: "s1", text: "buy a watering can", done: false }];
  const meta = { room: "kitchen", severity: 3 };
  const filed = await call(
    "file_todo",
    { title: "water the plants", notes: "they are thirsty", priority: "high", deadline, estimate: "2m", labels: ["chore", "home"], subtasks, meta },
    agentA,
  );
  assert.equal(filed.isError, false, filed.text);
  const todo = filed.data;
  assert.equal(typeof todo.id, "string");
  assert.equal(todo.sessionId, agentA, "owned by the calling session");
  assert.equal(todo.createdBy, "agent");
  assert.equal(todo.status, "open");
  assert.equal(todo.priority, "high");
  assert.equal(todo.deadline, deadline, "deadline (epoch ms) round-trips");
  assert.equal(todo.estimate, "2m");
  assert.deepEqual(todo.labels, ["chore", "home"]);
  assert.deepEqual(todo.subtasks, subtasks);
  assert.deepEqual(todo.meta, meta);
  assert.deepEqual(todo.sharedEditors, []);
  assert.deepEqual(todo.deniedEditors, []);

  /* the REST surface the user sees shows the identical row */
  const rest = await api("/api/todos");
  const row = rest.body.todos.find((t: Ev) => t.id === todo.id);
  assert.ok(row, "GET /api/todos lists it");
  assert.equal(row.sessionId, agentA);
  assert.equal(row.priority, "high");
  assert.equal(row.deadline, deadline);
  assert.deepEqual(row.subtasks, subtasks);

  /* the auto-posted feed card: type todo, dedupe-keyed todo:<id>, priority→importance */
  const feed = await api("/api/feed");
  const card = feed.body.items.find((i: Ev) => i.data?.todoId === todo.id && i.type === "todo");
  assert.ok(card, "linked card in the user's feed");
  assert.equal(card.sessionId, agentA);
  assert.equal(card.title, "water the plants");
  assert.equal(card.importance, "high", "non-normal priority becomes the card importance");
  assert.equal(card.state, "unread");

  /* postToFeed:false files no card */
  const silent = await call("file_todo", { title: "silent todo", postToFeed: false }, agentA);
  assert.equal(silent.isError, false);
  const feed2 = await api("/api/feed");
  assert.ok(!feed2.body.items.some((i: Ev) => i.data?.todoId === silent.data.id), "no card for postToFeed:false");
});

test("list_todos scoping + own-session update_todo/complete_todo; completing settles the feed card", async () => {
  assert.ok(agentA && agentB, "agents created by the file_todo test");
  const bTodo = await call("file_todo", { title: "B's private todo", postToFeed: false }, agentB);
  assert.equal(bTodo.isError, false);

  /* default mine:true — A sees only its own; mine:false sees everything */
  const mine = await call("list_todos", {}, agentA);
  assert.ok(mine.data.length >= 2, "A has two todos");
  assert.ok(mine.data.every((t: Ev) => t.sessionId === agentA), "default scope is the caller's own");
  const all = await call("list_todos", { mine: false }, agentA);
  assert.ok(all.data.some((t: Ev) => t.id === bTodo.data.id), "mine:false lists other sessions' todos");
  const onlyOpen = await call("list_todos", { mine: false, status: "open" }, agentA);
  assert.ok(onlyOpen.data.every((t: Ev) => t.status === "open"));
  /* unscoped connection quirk: callerId is undefined so the mine filter is
     skipped entirely — list_todos on bare /mcp/truss lists EVERYTHING even
     with the default mine:true (asserting actual source behavior) */
  const unscoped = await call("list_todos", {});
  assert.ok(unscoped.data.some((t: Ev) => t.id === bTodo.data.id), "unscoped list_todos sees foreign todos");

  /* owner edits its own todo */
  const upd = await call("update_todo", { id: bTodo.data.id, title: "B's renamed todo", priority: "urgent", deadline: 123 }, agentB);
  assert.equal(upd.isError, false, upd.text);
  assert.equal(upd.data.title, "B's renamed todo");
  assert.equal(upd.data.priority, "urgent");
  assert.equal(upd.data.deadline, 123);
  const restRow = (await api("/api/todos")).body.todos.find((t: Ev) => t.id === bTodo.data.id);
  assert.equal(restRow.priority, "urgent", "REST sees the edit");

  /* owner completes it → done + doneAt; the auto feed card settles to done */
  const withCard = await call("file_todo", { title: "todo with a card" }, agentA);
  const done = await call("complete_todo", { id: withCard.data.id }, agentA);
  assert.equal(done.isError, false);
  assert.equal(done.data.status, "done");
  assert.equal(typeof done.data.doneAt, "number", "doneAt stamped");
  const doneCards = await api("/api/feed?state=done");
  assert.ok(
    doneCards.body.items.some((i: Ev) => i.data?.todoId === withCard.data.id),
    "the todo's feed card settled to done alongside it",
  );

  /* complete_todo with status:'dropped' */
  const dropped = await call("complete_todo", { id: bTodo.data.id, status: "dropped" }, agentB);
  assert.equal(dropped.data.status, "dropped");
});

test("ownership: a foreign session's edit files an approval card (deduped); REST approve lets it through, deny sticks", async () => {
  assert.ok(agentA && agentB);
  const owned = await call("file_todo", { title: "owned by A", postToFeed: false }, agentA);
  const todoId = owned.data.id as string;

  /* B edits A's todo → NOT an rpc error: a successful result carrying a
     pending marker; the todo itself is untouched */
  const attempt = await call("update_todo", { id: todoId, title: "hijacked by B" }, agentB);
  assert.equal(attempt.isError, false, attempt.text);
  assert.ok(String(attempt.data?.pending).includes("approval requested"), "pending marker returned");
  let row = (await api("/api/todos")).body.todos.find((t: Ev) => t.id === todoId);
  assert.equal(row.title, "owned by A", "no edit landed before approval");

  /* the approval card in the user's feed */
  const approvalCards = async () =>
    (await api("/api/feed")).body.items.filter((i: Ev) => i.data?.accessRequest === true && i.data?.todoId === todoId);
  let cards = await approvalCards();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].type, "todo");
  assert.equal(cards[0].title, "Edit request: owned by A");
  assert.equal(cards[0].data.requesterId, agentB);
  assert.equal(cards[0].sessionId, agentA, "card is attributed to the owning session");
  assert.equal(cards[0].importance, "high");
  assert.ok(String(cards[0].body).includes("mcp-agent-b"), "requester title in the card body");

  /* repeated nagging is dedupe-keyed (todo-access:<todo>:<requester>) — and
     complete_todo on a foreign todo hits the same gate */
  const again = await call("update_todo", { id: todoId, title: "hijack again" }, agentB);
  assert.ok(String(again.data?.pending).includes("approval requested"));
  const doneAttempt = await call("complete_todo", { id: todoId }, agentB);
  assert.ok(String(doneAttempt.data?.pending).includes("approval requested"), "complete_todo gated the same way");
  cards = await approvalCards();
  assert.equal(cards.length, 1, "still exactly one approval card");

  /* the user resolves it via the REST access route (the MCP server exposes no
     resolve tool — resolution is user-only) */
  const approve = await post(`/api/todos/${todoId}/access`, { requesterId: agentB, approve: true });
  assert.equal(approve.status, 200);
  assert.ok(approve.body.todo.sharedEditors.includes(agentB), "B is now a shared editor");

  const retry = await call("update_todo", { id: todoId, title: "edited by B with blessing" }, agentB);
  assert.equal(retry.isError, false, retry.text);
  assert.equal(retry.data.title, "edited by B with blessing");

  /* deny path: a second todo, the user says no, B is told so (as a tool error) */
  const owned2 = await call("file_todo", { title: "A's second todo", postToFeed: false }, agentA);
  const pending2 = await call("update_todo", { id: owned2.data.id, title: "nope" }, agentB);
  assert.ok(String(pending2.data?.pending).includes("approval requested"));
  const deny = await post(`/api/todos/${owned2.data.id}/access`, { requesterId: agentB, approve: false });
  assert.equal(deny.status, 200);
  assert.ok(deny.body.todo.deniedEditors.includes(agentB));
  const after = await call("update_todo", { id: owned2.data.id, title: "nope" }, agentB);
  assert.equal(after.isError, true);
  assert.ok(after.text.includes("the user denied this session access to that task"), after.text);

  /* editing a todo that doesn't exist is a tool error, not a pending marker */
  const missing = await call("update_todo", { id: "no-such-todo", title: "x" }, agentA);
  assert.equal(missing.isError, true);
  assert.ok(missing.text.includes("no such todo: no-such-todo"));
});

test("post_feed + list_feed: cards land in the user's inbox; list_feed only shows cards shared to the caller", async () => {
  assert.ok(agentA && agentB);
  const report = await call(
    "post_feed",
    { type: "report", title: "A's report", body: "findings in **markdown**", importance: "high", data: { pages: 3 } },
    agentA,
  );
  assert.equal(report.isError, false, report.text);
  assert.equal(report.data.sessionId, agentA);
  assert.equal(report.data.type, "report");
  assert.equal(report.data.importance, "high");
  assert.equal(report.data.state, "unread");
  assert.deepEqual(report.data.data, { pages: 3 });

  /* the user's REST inbox sees it; the author's list_feed does NOT (nothing shared to A yet) */
  const inbox = await api("/api/feed");
  assert.ok(inbox.body.items.some((i: Ev) => i.id === report.data.id), "user inbox has the card");
  const aFeed0 = await call("list_feed", {}, agentA);
  assert.ok(!aFeed0.data.some((i: Ev) => i.id === report.data.id), "own card isn't 'shared to' its author");

  /* B posts a note shared with A → visible to A via list_feed, invisible to B */
  const note = await call("post_feed", { type: "note", title: "for A only", sharedWith: [agentA] }, agentB);
  assert.equal(note.isError, false);
  assert.deepEqual(note.data.sharedWith, [agentA]);
  const aFeed = await call("list_feed", {}, agentA);
  assert.ok(aFeed.data.some((i: Ev) => i.id === note.data.id), "shared card reaches A's list_feed");
  const bFeed = await call("list_feed", {}, agentB);
  assert.ok(!bFeed.data.some((i: Ev) => i.id === note.data.id), "B does not see its own card unless shared back");

  /* post_feed is user-inbox-facing: unscoped connections can't use it */
  const unscoped = await call("post_feed", { title: "anonymous" });
  assert.equal(unscoped.isError, true);
  assert.ok(unscoped.text.includes("unscoped MCP connection"));
});

test("task board: create_task → run_task spawns a real session that completes; status todo→doing (never auto-done); update_task", async () => {
  const created = await call("create_task", {
    title: "mcp task run",
    prompt: "say hi from the task board",
    cwd: "/tmp",
    harness: "pi",
  });
  assert.equal(created.isError, false, created.text);
  const taskId = created.data.id as string;
  assert.equal(created.data.status, "todo");

  /* run_task: returns the new session, flips the card to doing */
  const run = await call("run_task", { id: taskId });
  assert.equal(run.isError, false, run.text);
  const runSid = run.data.sessionId as string;
  assert.equal(run.data.harness, "pi");
  assert.equal(run.data.cwd, "/tmp");
  spawned.add(runSid);
  const duringRun = (await api("/api/tasks")).body.tasks.find((t: Ev) => t.id === taskId);
  assert.equal(duringRun.status, "doing", "card flips todo → doing at run start");
  assert.equal(duringRun.sessionId, runSid, "card links the spawned session");

  /* the fake pi answers by itself — wait for the settled turn */
  const evs = (await waitFor(async () => {
    const list = await eventsOf(runSid);
    return list.some((e) => e.type === "llm.call.done") && list.some((e) => e.type === "msg.done" && !e.role) ? list : null;
  }, "task run turn to settle", 15000)) as Ev[];
  assert.ok(evs.some((e) => e.type === "msg.chunk" && String(e.text).includes("REPLY:say hi from the task board")), "task prompt went out");
  const meta = await api(`/api/sessions/${runSid}`);
  assert.equal(meta.body.session.project, "taskboard", "run sessions are grouped under the taskboard project");

  /* once idle, the autoposter files a task_run card — but per the source the
     task status STAYS "doing" (the card body says "Review the run, then move
     the card"); nothing auto-marks it done. Asserting actual behavior. */
  await waitFor(async () => {
    const feed = await api("/api/feed");
    return feed.body.items.some((i: Ev) => i.type === "task_run" && i.data?.taskId === taskId) || null;
  }, "task_run feed card after settle");
  const afterRun = (await api("/api/tasks")).body.tasks.find((t: Ev) => t.id === taskId);
  assert.equal(afterRun.status, "doing", "a finished run does NOT auto-complete the card");

  /* the user/agent moves it manually; the status filter on list_tasks works */
  const moved = await call("update_task", { id: taskId, status: "done" });
  assert.equal(moved.data.status, "done");
  const doneOnly = await call("list_tasks", { status: "done" });
  assert.ok(doneOnly.data.some((t: Ev) => t.id === taskId), "status filter sees it");
  const todoOnly = await call("list_tasks", { status: "todo" });
  assert.ok(!todoOnly.data.some((t: Ev) => t.id === taskId));

  /* run_task error paths per the source */
  const noPrompt = await call("create_task", { title: "no prompt task", cwd: "/tmp", harness: "pi" });
  const emptyRun = await call("run_task", { id: noPrompt.data.id });
  assert.equal(emptyRun.isError, true);
  assert.ok(emptyRun.text.includes("task has no prompt to run"), emptyRun.text);
  const ghost = await call("run_task", { id: "no-such-task" });
  assert.equal(ghost.isError, true);
  assert.ok(ghost.text.includes("no such task: no-such-task"));
  const noTitle = await call("create_task", { cwd: "/tmp", harness: "pi" });
  assert.equal(noTitle.isError, true);
  assert.ok(noTitle.text.includes("title required"));
});

test("error paths: isError tool results vs true JSON-RPC errors vs 202 notifications", async () => {
  assert.ok(agentA, "agent A exists");

  /* unknown tool → MCP-style isError RESULT (jsonrpc has no error member).
     The task spec said "JSON-RPC error" but the source deliberately wraps
     every tool exception as result.isError — asserting actual behavior. */
  const unknown = await mcp("tools/call", { name: "nope_tool", arguments: {} }, agentA);
  assert.equal(unknown.status, 200);
  assert.equal(unknown.body.error, undefined, "no rpc-level error for tool failures");
  assert.equal(unknown.body.result.isError, true);
  assert.ok(unknown.body.result.content[0].text.includes("unknown tool: nope_tool"));

  /* tools/call without params.name → real JSON-RPC error -32602 */
  const noName = await mcp("tools/call", { arguments: {} }, agentA);
  assert.equal(noName.body.error?.code, -32602);
  assert.equal(noName.body.error?.message, "tool name required");

  /* unknown method WITH an id → -32601; WITHOUT an id → bare 202 (notification) */
  const badMethod = await mcp("bogus/method");
  assert.equal(badMethod.body.error?.code, -32601);
  assert.ok(String(badMethod.body.error?.message).includes("method not found: bogus/method"));
  const notif = await mcp("bogus/method", undefined, undefined, true);
  assert.equal(notif.status, 202, "unknown notifications are swallowed with 202");
  assert.equal(notif.body, null);
  const initNotif = await mcp("notifications/initialized", undefined, undefined, true);
  assert.equal(initNotif.status, 202);

  /* ping → empty result object */
  const ping = await mcp("ping");
  assert.deepEqual(ping.body.result, {});

  /* file_todo validation + scoping */
  const noTitle = await call("file_todo", { notes: "no title" }, agentA);
  assert.equal(noTitle.isError, true);
  assert.ok(noTitle.text.includes("title required"));
  const unscoped = await call("file_todo", { title: "no session scope" });
  assert.equal(unscoped.isError, true);
  assert.ok(unscoped.text.includes("unscoped MCP connection — respawn the session"));

  /* nonexistent session id: the route does NOT validate :sessionId, so
     file_todo dies deep in the store with a raw SQLite FK violation instead
     of a clean "no such session" (reporting as a surprise — see summary).
     feed_items.session_id has no FK at all, so post_feed with a ghost id
     SUCCEEDS — same route, inconsistent depth of failure. */
  const ghostTodo = await call("file_todo", { title: "ghost todo", postToFeed: false }, "ghost-session-id");
  assert.equal(ghostTodo.isError, true);
  assert.match(ghostTodo.text, /FOREIGN KEY constraint failed/, ghostTodo.text);
  const ghostFeed = await call("post_feed", { title: "ghost card" }, "ghost-session-id");
  assert.equal(ghostFeed.isError, false, "post_feed happily files for a nonexistent session");
  const inbox = await api("/api/feed");
  assert.ok(inbox.body.items.some((i: Ev) => i.id === ghostFeed.data.id && i.sessionId === "ghost-session-id"));

  /* GET on the endpoint exists only to say no */
  const g = await fetch(`${srv.base}/mcp/truss`);
  assert.equal(g.status, 405);
  assert.equal(g.headers.get("allow"), "POST");
});

test("session tools over MCP: list/get/rename/project/archive/harnesses/agents/costs/settings + create/prompt/close/delete", async () => {
  const sid = await mkSession("mcp-listed");

  /* list_sessions reflects reality */
  const list = await call("list_sessions");
  const row = list.data.find((s: Ev) => s.id === sid);
  assert.ok(row, "REST-created session is visible over MCP");
  assert.equal(row.title, "mcp-listed");
  assert.equal(row.harness, "pi");
  assert.equal(row.live, true, "fake pi is live");
  assert.equal(row.archived, false);
  assert.ok(typeof row.updated_at === "number");

  /* get_session returns the raw (snake_case) row + live flag */
  const got = await call("get_session", { id: sid });
  assert.equal(got.data.id, sid);
  assert.equal(got.data.cwd, "/tmp");
  assert.equal(got.data.live, true);
  const gotGhost = await call("get_session", { id: "nope-nope" });
  assert.equal(gotGhost.isError, true);
  assert.ok(gotGhost.text.includes("no such session: nope-nope"));

  /* rename + regroup, verified via REST */
  const renamed = await call("rename_session", { id: sid, title: "mcp-renamed" });
  assert.deepEqual(renamed.data, { ok: true, id: sid, title: "mcp-renamed" });
  assert.equal((await api(`/api/sessions/${sid}`)).body.session.title, "mcp-renamed");
  const emptyTitle = await call("rename_session", { id: sid, title: "   " });
  assert.equal(emptyTitle.isError, true);
  assert.ok(emptyTitle.text.includes("title must not be empty"));

  await call("set_project", { id: sid, project: "mcp-proj" });
  const inProj = await call("list_sessions", { project: "mcp-proj" });
  assert.ok(inProj.data.some((s: Ev) => s.id === sid), "project filter finds it");
  const notInProj = await call("list_sessions", { project: "mcp-proj-that-is-empty" });
  assert.equal(notInProj.data.length, 0);

  /* archive hides from the default list; includeArchived brings it back */
  await call("archive_session", { id: sid, archived: true });
  assert.ok(!(await call("list_sessions")).data.some((s: Ev) => s.id === sid), "archived hidden by default");
  const withArchived = await call("list_sessions", { includeArchived: true });
  assert.equal(withArchived.data.find((s: Ev) => s.id === sid)?.archived, true);
  await call("archive_session", { id: sid, archived: false });
  assert.ok((await call("list_sessions")).data.some((s: Ev) => s.id === sid));

  /* send_prompt round-trips through the fake pi */
  const prompted = await call("send_prompt", { id: sid, text: "hello from mcp" });
  assert.deepEqual(prompted.data, { ok: true });
  await waitFor(
    async () => (await eventsOf(sid)).some((e) => e.type === "llm.call.done") || null,
    "MCP-sent prompt settles",
    15000,
  );

  /* read-only fleet tools */
  const harnesses = await call("list_harnesses");
  assert.ok(harnesses.data.harnesses.some((h: Ev) => h.id === "pi"));
  assert.ok(harnesses.data.models.some((m: Ev) => m.harness === "pi" && m.model === "m-fast"), "fake catalog models listed");
  const agents = await call("list_agents");
  assert.deepEqual(agents.data, { agents: [] }, "no node-agents connected in this harness");
  const costs = await call("get_costs");
  assert.ok(Array.isArray(costs.data.sessions));
  for (const k of ["calls", "tokensIn", "tokensOut", "costUsd"]) {
    assert.equal(typeof costs.data.totals[k], "number", `totals.${k} numeric`);
  }

  /* settings live in the layout doc; the patch merges */
  const patched = await call("update_settings", { patch: { density: "compact" } });
  assert.equal(patched.data.ok, true);
  assert.equal(patched.data.settings.density, "compact");
  const settings = await call("get_settings");
  assert.equal(settings.data.settings.density, "compact", "get_settings reflects the patch");
  const workspaces = await call("list_workspaces");
  assert.deepEqual(workspaces.data, [], "no workspaces in a fresh data dir");
  const layout = await call("get_layout");
  assert.equal(layout.data.settings.density, "compact", "the layout doc carries the settings");

  /* create_session over MCP spawns a real (fake) pi; close + delete manage it */
  const made = await call("create_session", { harness: "pi", cwd: "/tmp", title: "mcp-spawned" });
  assert.equal(made.isError, false, made.text);
  const madeId = made.data.id as string;
  assert.equal(made.data.title, "mcp-spawned");
  assert.ok((await api(`/api/sessions/${madeId}`)).body.session, "visible over REST");
  const closed = await call("close_session", { id: madeId });
  assert.deepEqual(closed.data, { ok: true });
  const closedMeta = await api(`/api/sessions/${madeId}`);
  assert.equal(closedMeta.body.session.state, "closed");
  assert.equal(closedMeta.body.session.live, false);

  /* BUG-ish, asserting actual behavior: delete_session IGNORES its `hard`
     argument — the handler always hard-deletes (row + transcript) and always
     answers hard:true, even when the caller passes hard:false. Reported. */
  const del = await call("delete_session", { id: madeId, hard: false });
  assert.deepEqual(del.data, { ok: true, hard: true });
  assert.equal((await api(`/api/sessions/${madeId}`)).status, 404, "row gone despite hard:false");
});
