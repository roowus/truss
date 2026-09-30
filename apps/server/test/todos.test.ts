import { test } from "node:test";
import assert from "node:assert/strict";
import { freshServer } from "./helpers.js";

/* todos.ts — user-facing tasks with per-session ownership enforcement.
   NB: the module cache pins every test in this file to the FIRST freshServer
   dir, so all tests share one store — every assertion filters by the ids the
   test itself created instead of counting global rows. listTodos() takes no
   filters in the real API (no project/session/status/search params), so
   listing is covered by membership checks. */

test("createTodo: defaults, trimmed title, broadcast, auto feed card, opt-out", async () => {
  const { cleanup } = await freshServer("td-create");
  const todos = await import("../src/todos.js");
  const feed = await import("../src/feed.js");
  const seen: string[] = [];
  todos.setTodoBroadcaster((t) => seen.push(t.id));
  try {
    const t = todos.createTodo({ title: "  write the tests  ", createdBy: "user" });
    assert.equal(t.title, "write the tests", "title is trimmed");
    assert.equal(t.id.length, 8);
    assert.equal(t.notes, "");
    assert.equal(t.priority, "normal");
    assert.equal(t.status, "open");
    assert.deepEqual(t.labels, []);
    assert.deepEqual(t.subtasks, []);
    assert.deepEqual(t.meta, {});
    assert.deepEqual(t.sharedEditors, []);
    assert.deepEqual(t.deniedEditors, []);
    assert.equal(t.sessionId, undefined);
    assert.equal(t.deadline, undefined);
    assert.equal(t.estimate, undefined);
    assert.equal(t.doneAt, undefined);
    assert.equal(t.createdBy, "user");
    assert.ok(t.createdAt > 0 && t.updatedAt > 0);
    assert.deepEqual(seen, [t.id], "create broadcasts the todo");

    // listed + gettable
    assert.ok(todos.listTodos().some((x) => x.id === t.id));
    assert.equal(todos.getTodo(t.id)?.title, "write the tests");
    assert.equal(todos.getTodo("td-no-such"), undefined);

    // auto-posted feed card, dedupe-keyed to the todo
    const cards = feed.listFeed({ state: "unread" }).filter((c) => c.data.todoId === t.id);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].type, "todo");
    assert.equal(cards[0].importance, "normal", "normal priority maps to normal importance");
    assert.equal(cards[0].title, t.title);

    // postToFeed: false opts out of the card
    const quiet = todos.createTodo({ title: "quiet", createdBy: "agent", postToFeed: false });
    assert.equal(feed.listFeed().filter((c) => c.data.todoId === quiet.id).length, 0);

    assert.throws(() => todos.createTodo({ title: "   ", createdBy: "user" }), /title required/);
  } finally {
    todos.setTodoBroadcaster(() => {});
    cleanup();
  }
});

test("createTodo: every field round-trips; unknown sessionId hits the FK", async () => {
  const { db, cleanup } = await freshServer("td-full");
  const todos = await import("../src/todos.js");
  const feed = await import("../src/feed.js");
  try {
    db.store.createSession({ id: "td-full-owner", harness: "pi", title: "owner", cwd: "/tmp" });
    const deadline = Date.now() + 86_400_000;
    const t = todos.createTodo({
      title: "full fat",
      notes: "with **markdown**",
      priority: "urgent",
      deadline,
      estimate: "L",
      labels: ["web", "release"],
      subtasks: [{ id: "st1", text: "draft", done: false }],
      meta: { jira: "TRU-1", rank: 3 },
      sessionId: "td-full-owner",
      createdBy: "agent",
    });
    const got = todos.getTodo(t.id)!;
    assert.equal(got.sessionId, "td-full-owner");
    assert.equal(got.notes, "with **markdown**");
    assert.equal(got.priority, "urgent");
    assert.equal(got.deadline, deadline);
    assert.equal(got.estimate, "L");
    assert.deepEqual(got.labels, ["web", "release"]);
    assert.deepEqual(got.subtasks, [{ id: "st1", text: "draft", done: false }]);
    assert.deepEqual(got.meta, { jira: "TRU-1", rank: 3 });
    assert.equal(got.createdBy, "agent");

    // non-normal priority becomes the card's importance
    const card = feed.listFeed().find((c) => c.data.todoId === t.id);
    assert.equal(card?.importance, "urgent");
    assert.equal(card?.sessionId, "td-full-owner");

    // foreign_keys is ON: an unknown sessionId is rejected by sqlite (raw error)
    assert.throws(
      () => todos.createTodo({ title: "orphan", createdBy: "agent", sessionId: "td-no-session" }),
      /FOREIGN KEY/,
    );
  } finally {
    cleanup();
  }
});

test("userUpdateTodo: edits every field, subtask add/toggle, null clears, validation", async () => {
  const { cleanup } = await freshServer("td-useredit");
  const todos = await import("../src/todos.js");
  try {
    const t = todos.createTodo({ title: "before", createdBy: "user", postToFeed: false });
    const deadline = Date.now() + 60_000;
    const u = todos.userUpdateTodo(t.id, {
      title: "after",
      notes: "n",
      priority: "high",
      deadline,
      estimate: "20m",
      labels: ["x"],
      subtasks: [{ id: "a", text: "first", done: false }],
      meta: { k: 1 },
    });
    assert.equal(u.title, "after");
    assert.equal(u.notes, "n");
    assert.equal(u.priority, "high");
    assert.equal(u.deadline, deadline);
    assert.equal(u.estimate, "20m");
    assert.deepEqual(u.labels, ["x"]);
    assert.deepEqual(u.meta, { k: 1 });

    // subtasks have no dedicated API — add/toggle is a wholesale array patch
    const toggled = todos.userUpdateTodo(t.id, {
      subtasks: [
        { id: "a", text: "first", done: true },
        { id: "b", text: "second", done: false },
      ],
    });
    assert.deepEqual(toggled.subtasks, [
      { id: "a", text: "first", done: true },
      { id: "b", text: "second", done: false },
    ]);

    // explicit nulls clear deadline/estimate (undefined leaves them alone)
    const cleared = todos.userUpdateTodo(t.id, { deadline: null, estimate: null });
    assert.equal(cleared.deadline, undefined);
    assert.equal(cleared.estimate, undefined);

    assert.throws(() => todos.userUpdateTodo(t.id, { priority: "bogus" as never }), /bad priority/);
    assert.throws(() => todos.userUpdateTodo(t.id, { status: "bogus" as never }), /bad status/);
    assert.throws(() => todos.userUpdateTodo("td-missing", { title: "x" }), /no such todo/);
  } finally {
    cleanup();
  }
});

test("userUpdateTodo: done stamps done_at and settles the feed card; reopen clears", async () => {
  const { cleanup } = await freshServer("td-lifecycle");
  const todos = await import("../src/todos.js");
  const feed = await import("../src/feed.js");
  try {
    const t = todos.createTodo({ title: "lifecycle", createdBy: "agent" }); // auto-posts a card
    const before = Date.now();
    const done = todos.userUpdateTodo(t.id, { status: "done" });
    assert.equal(done.status, "done");
    assert.ok(typeof done.doneAt === "number" && done.doneAt >= before, "done_at stamped");
    // the todo's open feed card is settled to "done" along with it
    const card = feed.listFeed({ state: "done" }).find((c) => c.data.todoId === t.id);
    assert.ok(card, "todo card settled to done");

    const reopened = todos.userUpdateTodo(t.id, { status: "open" });
    assert.equal(reopened.status, "open");
    assert.equal(reopened.doneAt, undefined, "reopening clears done_at");

    const redone = todos.userUpdateTodo(t.id, { status: "done" });
    const dropped = todos.userUpdateTodo(t.id, { status: "dropped" });
    // surprising but actual: dropping KEEPS the previous done_at
    // (applyPatch falls through to `t.doneAt ?? null` for "dropped")
    assert.equal(dropped.status, "dropped");
    assert.equal(dropped.doneAt, redone.doneAt);
  } finally {
    cleanup();
  }
});

test("agentUpdateTodo: the owning session edits directly; missing id is not_found", async () => {
  const { db, cleanup } = await freshServer("td-own");
  const todos = await import("../src/todos.js");
  try {
    db.store.createSession({ id: "td-own-a", harness: "pi", title: "owner a", cwd: "/tmp" });
    const t = todos.createTodo({ title: "mine", createdBy: "agent", sessionId: "td-own-a", postToFeed: false });
    const r = todos.agentUpdateTodo("td-own-a", t.id, { status: "done", notes: "finished" });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.todo.status, "done");
      assert.equal(r.todo.notes, "finished");
      assert.ok(r.todo.doneAt, "agent completion also stamps done_at");
    }
    assert.deepEqual(todos.agentUpdateTodo("td-own-a", "td-missing", { title: "x" }), {
      ok: false,
      reason: "not_found",
    });
  } finally {
    cleanup();
  }
});

test("agentUpdateTodo: foreign session files ONE approval card; approval grants edits", async () => {
  const { db, cleanup } = await freshServer("td-foreign");
  const todos = await import("../src/todos.js");
  const feed = await import("../src/feed.js");
  try {
    db.store.createSession({ id: "td-f-owner", harness: "pi", title: "owner", cwd: "/tmp" });
    db.store.createSession({ id: "td-f-req", harness: "pi", title: "requester bot", cwd: "/tmp" });
    const t = todos.createTodo({
      title: "shared task",
      createdBy: "agent",
      sessionId: "td-f-owner",
      postToFeed: false,
    });

    const r1 = todos.agentUpdateTodo("td-f-req", t.id, { status: "done" });
    assert.deepEqual(r1, { ok: false, reason: "approval_requested" });
    assert.equal(todos.getTodo(t.id)?.status, "open", "foreign edit did NOT silently apply");

    const accessCards = () => feed.listFeed().filter((c) => c.data.accessRequest === true && c.data.todoId === t.id);
    assert.equal(accessCards().length, 1);
    const card = accessCards()[0];
    assert.equal(card.type, "todo");
    assert.equal(card.importance, "high");
    assert.equal(card.sessionId, "td-f-owner", "card is addressed to the owning session");
    assert.equal(card.data.requesterId, "td-f-req");
    assert.ok(card.body.includes("requester bot"), "body names the requester session");
    assert.ok(card.body.includes("**done**"), "body describes the requested status");

    // repeat attempts dedupe on todo-access:<id>:<requester> — still one card
    todos.agentUpdateTodo("td-f-req", t.id, { status: "done" });
    assert.equal(accessCards().length, 1);

    const approved = todos.resolveTodoAccess(t.id, "td-f-req", true);
    assert.deepEqual(approved.sharedEditors, ["td-f-req"]);
    assert.deepEqual(approved.deniedEditors, []);
    const r2 = todos.agentUpdateTodo("td-f-req", t.id, { status: "done" });
    assert.equal(r2.ok, true, "shared editor can now edit");
    if (r2.ok) assert.equal(r2.todo.status, "done");
  } finally {
    cleanup();
  }
});

test("agentUpdateTodo: denial is quiet; a later approval lifts it", async () => {
  const { db, cleanup } = await freshServer("td-deny");
  const todos = await import("../src/todos.js");
  const feed = await import("../src/feed.js");
  try {
    db.store.createSession({ id: "td-d-owner", harness: "pi", title: "owner", cwd: "/tmp" });
    const t = todos.createTodo({ title: "guarded", createdBy: "agent", sessionId: "td-d-owner", postToFeed: false });

    assert.deepEqual(todos.agentUpdateTodo("td-d-req", t.id, { title: "hacked" }), {
      ok: false,
      reason: "approval_requested",
    });
    const denied = todos.resolveTodoAccess(t.id, "td-d-req", false);
    assert.deepEqual(denied.deniedEditors, ["td-d-req"]);
    assert.deepEqual(denied.sharedEditors, []);

    const cardsBefore = feed.listFeed().filter((c) => c.data.todoId === t.id).length;
    assert.deepEqual(todos.agentUpdateTodo("td-d-req", t.id, { title: "hacked" }), { ok: false, reason: "denied" });
    assert.equal(
      feed.listFeed().filter((c) => c.data.todoId === t.id).length,
      cardsBefore,
      "a denied edit files no new card",
    );
    assert.equal(todos.getTodo(t.id)?.title, "guarded", "denied edit did not apply");

    // approving after a deny lifts the denial (removes from deniedEditors)
    const approved = todos.resolveTodoAccess(t.id, "td-d-req", true);
    assert.deepEqual(approved.sharedEditors, ["td-d-req"]);
    assert.deepEqual(approved.deniedEditors, []);
    assert.equal(todos.agentUpdateTodo("td-d-req", t.id, { title: "let in" }).ok, true, "approved-after-deny can edit");

    assert.throws(() => todos.resolveTodoAccess("td-missing", "td-d-req", true), /no such todo/);
  } finally {
    cleanup();
  }
});

test("agentUpdateTodo: unowned todos are world-editable; deleting the owner unowns", async () => {
  const { db, cleanup } = await freshServer("td-unowned");
  const todos = await import("../src/todos.js");
  try {
    // actual behavior: the ownership guard only fires when sessionId is set, so
    // user-filed (sessionless) todos can be edited by ANY agent session
    const userTodo = todos.createTodo({ title: "user task", createdBy: "user", postToFeed: false });
    const r = todos.agentUpdateTodo("td-any-agent", userTodo.id, { status: "done" });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.todo.status, "done");

    // todos.session_id is REFERENCES sessions(id) ON DELETE SET NULL — the todo
    // survives its session and becomes unowned (and therefore world-editable)
    db.store.createSession({ id: "td-u-owner", harness: "pi", title: "doomed", cwd: "/tmp" });
    const owned = todos.createTodo({
      title: "orphan soon",
      createdBy: "agent",
      sessionId: "td-u-owner",
      postToFeed: false,
    });
    db.store.deleteSession("td-u-owner");
    assert.equal(todos.getTodo(owned.id)?.sessionId, undefined, "todo survives its session, unowned");
    const r2 = todos.agentUpdateTodo("td-any-agent", owned.id, { title: "adopted" });
    assert.equal(r2.ok, true);
    if (r2.ok) assert.equal(r2.todo.title, "adopted");
  } finally {
    cleanup();
  }
});

test("answering an access request SETTLES its feed card (issue #35) — answered asks never linger unread", async () => {
  const { db, cleanup } = await freshServer("td-settle");
  const todos = await import("../src/todos.js");
  const feed = await import("../src/feed.js");
  try {
    db.store.createSession({ id: "td-s-owner", harness: "pi", title: "owner", cwd: "/tmp" });
    db.store.createSession({ id: "td-s-req", harness: "pi", title: "requester", cwd: "/tmp" });
    const t = todos.createTodo({ title: "guarded", createdBy: "agent", sessionId: "td-s-owner", postToFeed: false });

    const r = todos.agentUpdateTodo("td-s-req", t.id, { title: "hacked" });
    assert.deepEqual(r, { ok: false, reason: "approval_requested" });
    const card = feed.listFeed({}).find((c: { dedupeKey?: string }) => c.dedupeKey === `todo-access:${t.id}:td-s-req`);
    assert.ok(card, "the ask is in the inbox");
    assert.equal(card!.state, "unread");

    todos.resolveTodoAccess(t.id, "td-s-req", true);
    const settled = feed.getFeedItem(card!.id);
    assert.equal(settled?.state, "done", "the card settles when answered");
  } finally {
    cleanup();
  }
});
