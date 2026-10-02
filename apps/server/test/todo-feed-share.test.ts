import { test } from "node:test";
import assert from "node:assert/strict";
import { freshServer } from "./helpers.js";
import type { AdapterHandle, HarnessAdapter, SessionOpts } from "../src/adapters/types.js";

/* SPEC-TESTS for todos in the feed + shareable todos —
   https://github.com/roowus/truss/issues/26
   ("All todos should show up in feed as well, and todos should be
   shareable"). These FAIL on purpose today: they pin the contract a fix must
   satisfy.

   Today's gaps (investigated):
   - Agent-filed todos post a feed card (mcp-truss.ts:511), but USER-created
     todos don't — the panel's route passes postToFeed:false
     (index.ts:547). The user's own todos never reach the feed, and todos
     created before the feature have no cards at all.
   - Todos have EDIT sharing (shared_editors + approval cards,
     todos.ts:196-217) but no VIEW sharing / share action; feed cards have
     sharedWith + a share route — todos need the same.

   The contract (todos.ts):
   - createUserTodo(input) — the user-sovereign creation path ALWAYS posts
     the linked feed card (route delegates to it);
   - backfillTodoFeedCards() — every existing todo gets its card, idempotently
     (dedupeKey todo:<id> already guards re-runs);
   - shareTodo(id, sessionId, note?) — view-shares the todo (sharedWith on
     the todo), shares its feed card too, and prompts the target session
     with the todo's title + the note (composition per #24). Rosters dedupe;
     unknown todo/session reject cleanly.

   The TodosPanel share button + the feed card rendering are acceptance
   criteria, not here. */

function fakeAdapter(id: string, rec: { sent: string[] }): HarnessAdapter {
  return {
    id: id as never,
    capabilities: { permissions: false, subagents: false, streaming: true, queueWhileRunning: true },
    async listModels() {
      return [];
    },
    async spawn(opts: SessionOpts): Promise<AdapterHandle> {
      return { sessionId: opts.sessionId };
    },
    send(_h: AdapterHandle, text: string) {
      rec.sent.push(text);
    },
    interrupt() {},
    async *events() {
      await new Promise(() => {});
      yield undefined as never;
    },
    dispose() {},
  };
}

async function setup(tag: string) {
  const { db, cleanup } = await freshServer(tag);
  const sessions = await import("../src/sessions.js");
  const feed = await import("../src/feed.js");
  const todos = await import("../src/todos.js");
  const rec: { sent: string[] } = { sent: [] };
  sessions.registerAdapter("fake-tshare" as never, fakeAdapter("fake-tshare", rec));
  const target = await sessions.createSession({ harness: "fake-tshare" as never, cwd: "/tmp", title: "teammate session" });
  return {
    db,
    feed,
    todos: todos as any,
    rec,
    target,
    cleanup: () => {
      sessions.unregisterAdapter("fake-tshare" as never);
      cleanup();
    },
  };
}

const todoCard = (feed: any, todoId: string) =>
  feed.listFeed({}).find((i: any) => i.dedupeKey === `todo:${todoId}`);

test("createUserTodo always posts the linked feed card — user todos reach the feed", async () => {
  const { feed, todos, cleanup } = await setup("todo-feed-user");
  try {
    assert.equal(typeof todos.createUserTodo, "function", "todos.ts must export createUserTodo (the route's always-posts path) — see issue #26");
    const t = todos.createUserTodo({ title: "my own todo" });
    const card = todoCard(feed, t.id);
    assert.ok(card, "a user-created todo shows up in the feed");
    assert.equal(card.type, "todo");
    assert.equal(card.title, "my own todo");
  } finally {
    cleanup();
  }
});

test("backfillTodoFeedCards: every existing todo gets a card, idempotently", async () => {
  const { feed, todos, cleanup } = await setup("todo-feed-backfill");
  try {
    assert.equal(typeof todos.backfillTodoFeedCards, "function", "todos.ts must export backfillTodoFeedCards — see issue #26");
    /* legacy rows: created without cards (the panel's old path) */
    const a = todos.createTodo({ title: "legacy a", createdBy: "user", postToFeed: false });
    const b = todos.createTodo({ title: "legacy b", createdBy: "agent", postToFeed: false });
    assert.ok(!todoCard(feed, a.id) && !todoCard(feed, b.id), "no cards yet");

    todos.backfillTodoFeedCards();
    assert.ok(todoCard(feed, a.id) && todoCard(feed, b.id), "every todo now has its card");

    todos.backfillTodoFeedCards();
    const count = feed.listFeed({}).filter((i: any) => i.dedupeKey === `todo:${a.id}`).length;
    assert.equal(count, 1, "re-running the backfill never duplicates a card");
  } finally {
    cleanup();
  }
});

test("shareTodo view-shares the todo + its card and prompts the target with the note", async () => {
  const { feed, todos, rec, target, cleanup } = await setup("todo-share");
  try {
    assert.equal(typeof todos.shareTodo, "function", "todos.ts must export shareTodo(id, sessionId, note?) — see issue #26");
    const t = todos.createTodo({ title: "review the schema", notes: "especially the FKs", createdBy: "user" });

    await todos.shareTodo(t.id, target.id, "have a look before lunch?");

    const todo = todos.getTodo(t.id);
    assert.ok((todo as any).sharedWith?.includes(target.id), "the todo itself is view-shared to the session");
    const card = todoCard(feed, t.id);
    assert.ok(card?.sharedWith?.includes(target.id), "its feed card travels too (the session's list_feed sees it)");

    const wire = rec.sent.at(-1)!;
    assert.ok(wire.includes("review the schema"), "the target chat hears the todo's title");
    assert.ok(wire.includes("have a look before lunch?"), "and my note (#24's composition)");
  } finally {
    cleanup();
  }
});

test("shareTodo dedupes rosters and rejects ghosts cleanly", async () => {
  const { todos, target, cleanup } = await setup("todo-share-edge");
  try {
    assert.equal(typeof todos.shareTodo, "function", "shareTodo must exist (see share test)");
    const t = todos.createTodo({ title: "shared twice", createdBy: "user" });

    await todos.shareTodo(t.id, target.id);
    await todos.shareTodo(t.id, target.id);
    const shared = (todos.getTodo(t.id) as any).sharedWith ?? [];
    assert.equal(shared.filter((s: string) => s === target.id).length, 1, "re-sharing never duplicates the roster");

    await assert.rejects(() => todos.shareTodo("no-such-todo", target.id), /no such todo/i);
    await assert.rejects(() => todos.shareTodo(t.id, "no-such-session"), /no such session/i);
  } finally {
    cleanup();
  }
});
