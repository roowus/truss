import { test } from "node:test";
import assert from "node:assert/strict";
import { freshServer } from "./helpers.js";
import type { FeedState } from "@truss/proto";

/* feed.ts — the unified inbox. Same shared-store caveat as the other suites:
   the module cache pins this file to the FIRST freshServer dir, so every test
   filters by its own ids/dedupe keys rather than counting global rows.
   listFeed() supports only {state, sharedWith, limit} in the real API — there
   are no type/importance/search filters (the client does that), so filtering
   coverage is exactly those three knobs. */

test("postFeed: defaults, full options, broadcast, getFeedItem", async () => {
  const { cleanup } = await freshServer("fd-post");
  const feed = await import("../src/feed.js");
  const seen: string[] = [];
  feed.setFeedBroadcaster((i) => seen.push(i.id));
  try {
    const { item, created } = feed.postFeed({ type: "note", title: "hello" });
    assert.equal(created, true);
    assert.equal(item.id.length, 8);
    assert.equal(item.type, "note");
    assert.equal(item.body, "");
    assert.equal(item.importance, "normal");
    assert.deepEqual(item.data, {});
    assert.equal(item.state, "unread");
    assert.deepEqual(item.sharedWith, []);
    assert.equal(item.sessionId, undefined);
    assert.ok(item.createdAt > 0 && item.updatedAt > 0);
    assert.deepEqual(seen, [item.id], "post broadcasts the item");
    assert.equal(feed.getFeedItem(item.id)?.title, "hello");
    assert.equal(feed.getFeedItem("fd-missing"), undefined);

    const db = await import("../src/db.js");
    db.store.createSession({ id: "fd-sess-1", harness: "pi", title: "fd session", cwd: "/tmp" });
    const full = feed.postFeed({
      type: "report",
      title: "full",
      body: "some **md**",
      sessionId: "fd-sess-1",
      importance: "urgent",
      data: { n: 1 },
      sharedWith: ["fd-sess-2"],
      state: "read",
    });
    assert.equal(full.created, true);
    assert.equal(full.item.importance, "urgent");
    assert.equal(full.item.body, "some **md**");
    assert.equal(full.item.sessionId, "fd-sess-1");
    assert.deepEqual(full.item.data, { n: 1 });
    assert.deepEqual(full.item.sharedWith, ["fd-sess-2"]);
    assert.equal(full.item.state, "read");
    assert.equal(seen.length, 2, "second post broadcasts too");
  } finally {
    feed.setFeedBroadcaster(() => {});
    cleanup();
  }
});

test("postFeed: a sessionId that resolves to no session coalesces to unattributed (issue #36)", async () => {
  const { cleanup } = await freshServer("fd-ghost-sess");
  const feed = await import("../src/feed.js");
  try {
    /* a stale/typo'd id from a future internal caller must not land a ghost
       card attributed to a nonexistent session — it still files, unattributed */
    const ghost = feed.postFeed({ type: "note", title: "fd-ghost-card", sessionId: "fd-no-such-session" });
    assert.equal(ghost.created, true);
    assert.equal(ghost.item.sessionId, undefined, "ghost session id coalesces to null");
    assert.equal(feed.getFeedItem(ghost.item.id)?.title, "fd-ghost-card", "the card still lands");

    /* a real session id is kept */
    const db = await import("../src/db.js");
    db.store.createSession({ id: "fd-real-sess", harness: "pi", title: "real", cwd: "/tmp" });
    const real = feed.postFeed({ type: "note", title: "fd-real-card", sessionId: "fd-real-sess" });
    assert.equal(real.item.sessionId, "fd-real-sess");
  } finally {
    cleanup();
  }
});

test("postFeed: a duplicate dedupeKey returns the original card unchanged", async () => {
  const { cleanup } = await freshServer("fd-dedupe");
  const feed = await import("../src/feed.js");
  try {
    const first = feed.postFeed({ type: "error", title: "boom v1", body: "first", dedupeKey: "fd:dedupe:1" });
    assert.equal(first.created, true);
    const again = feed.postFeed({
      type: "error",
      title: "boom v2",
      body: "second",
      importance: "high",
      dedupeKey: "fd:dedupe:1",
    });
    assert.equal(again.created, false);
    assert.equal(again.item.id, first.item.id);
    // actual behavior: the existing row comes back AS IS — title/body/importance
    // are NOT updated and updated_at is not bumped; dedupe only prevents a
    // second row from being inserted (and skips the broadcast)
    assert.equal(again.item.title, "boom v1");
    assert.equal(again.item.body, "first");
    assert.equal(again.item.importance, "normal");
    assert.equal(feed.listFeed().filter((c) => c.id === first.item.id).length, 1);

    // a different key is a different card
    const other = feed.postFeed({ type: "error", title: "boom v1", dedupeKey: "fd:dedupe:2" });
    assert.equal(other.created, true);
    assert.notEqual(other.item.id, first.item.id);
  } finally {
    cleanup();
  }
});

test("setFeedState: read/saved/dismissed/done transitions, inbox filtering, errors", async () => {
  const { cleanup } = await freshServer("fd-state");
  const feed = await import("../src/feed.js");
  try {
    const a = feed.postFeed({ type: "note", title: "fd-state-a" }).item;
    const b = feed.postFeed({ type: "note", title: "fd-state-b" }).item;
    const mine = (state?: FeedState) =>
      feed.listFeed(state ? { state } : {}).filter((c) => c.id === a.id || c.id === b.id);

    assert.equal(feed.setFeedState(a.id, "read").state, "read");
    assert.equal(feed.setFeedState(a.id, "saved").state, "saved");
    assert.ok(mine("saved").some((c) => c.id === a.id));
    assert.ok(!mine("unread").some((c) => c.id === a.id));

    // dismissed leaves the default inbox but stays addressable by state filter
    feed.setFeedState(b.id, "dismissed");
    assert.ok(!mine().some((c) => c.id === b.id), "default inbox hides dismissed");
    assert.ok(mine("dismissed").some((c) => c.id === b.id));
    assert.ok(mine().some((c) => c.id === a.id), "saved stays in the inbox");

    assert.equal(feed.setFeedState(a.id, "done").state, "done");
    assert.ok(mine().some((c) => c.id === a.id), "done still shows in the inbox (only dismissed is hidden)");

    assert.throws(() => feed.setFeedState("fd-missing", "read"), /no such feed item/);
    assert.throws(() => feed.setFeedState(a.id, "bogus" as never), /bad state/);
  } finally {
    cleanup();
  }
});

test("shareFeedItem: sharedWith round trip, idempotent, agent view; listFeed limit", async () => {
  const { cleanup } = await freshServer("fd-share");
  const feed = await import("../src/feed.js");
  try {
    const c1 = feed.postFeed({ type: "report", title: "fd-share-1" }).item;
    assert.deepEqual(feed.shareFeedItem(c1.id, "fd-agent-a").sharedWith, ["fd-agent-a"]);
    // idempotent — sharing the same session twice does not duplicate
    assert.deepEqual(feed.shareFeedItem(c1.id, "fd-agent-a").sharedWith, ["fd-agent-a"]);
    assert.deepEqual(feed.shareFeedItem(c1.id, "fd-agent-b").sharedWith, ["fd-agent-a", "fd-agent-b"]);

    // agent view: only cards shared to that session, with the card's REAL
    // id/type (the join must select feed_items.* so json_each's own columns
    // don't clobber them)
    const hitA = feed.listFeed({ sharedWith: "fd-agent-a" }).find((c) => c.title === "fd-share-1");
    assert.ok(hitA, "shared card is visible to the agent");
    assert.equal(hitA.id, c1.id, "agent can act on the card by its real id");
    assert.equal(hitA.type, "report", "real type survives");
    assert.deepEqual(hitA.sharedWith, ["fd-agent-a", "fd-agent-b"]);
    assert.ok(!feed.listFeed({ sharedWith: "fd-agent-c" }).some((c) => c.title === "fd-share-1"));

    // a dismissed card drops out of the shared view too
    const c2 = feed.postFeed({ type: "report", title: "fd-share-2" }).item;
    feed.shareFeedItem(c2.id, "fd-agent-a");
    feed.setFeedState(c2.id, "dismissed");
    assert.ok(!feed.listFeed({ sharedWith: "fd-agent-a" }).some((c) => c.title === "fd-share-2"));

    assert.throws(() => feed.shareFeedItem("fd-missing", "fd-agent-a"), /no such feed item/);

    // limit clamps the inbox (the shared store holds many cards by now)
    assert.equal(feed.listFeed({ limit: 1 }).length, 1);
  } finally {
    cleanup();
  }
});

test("settleFeedWhere: resolves open cards by dedupe prefix and returns the count", async () => {
  const { cleanup } = await freshServer("fd-settle");
  const feed = await import("../src/feed.js");
  try {
    const r1 = feed.postFeed({ type: "permission", title: "fd-perm-1", dedupeKey: "fdperm:r1" }).item;
    const r2 = feed.postFeed({ type: "permission", title: "fd-perm-2", dedupeKey: "fdperm:r2" }).item;
    const r3 = feed.postFeed({ type: "permission", title: "fd-perm-3", dedupeKey: "fdperm:r3" }).item;
    const other = feed.postFeed({ type: "note", title: "fd-note", dedupeKey: "fdother:x" }).item;
    feed.setFeedState(r2.id, "read"); // read still counts as open
    feed.setFeedState(r3.id, "dismissed"); // dismissed is already settled

    const n = feed.settleFeedWhere("fdperm:");
    assert.equal(n, 2, "unread + read matched, dismissed skipped");
    assert.equal(feed.getFeedItem(r1.id)?.state, "done");
    assert.equal(feed.getFeedItem(r2.id)?.state, "done");
    assert.equal(feed.getFeedItem(r3.id)?.state, "dismissed", "already-dismissed untouched");
    assert.equal(feed.getFeedItem(other.id)?.state, "unread", "non-matching prefix untouched");
    assert.equal(feed.settleFeedWhere("fdperm:"), 0, "nothing left open");

    // the target state is a parameter
    const s1 = feed.postFeed({ type: "note", title: "fd-settle-x", dedupeKey: "fdx:1" }).item;
    assert.equal(feed.settleFeedWhere("fdx:", "dismissed"), 1);
    assert.equal(feed.getFeedItem(s1.id)?.state, "dismissed");
  } finally {
    cleanup();
  }
});

test("feedSources: defaults all on, merges the layout doc's settings, survives junk", async () => {
  const { db, cleanup } = await freshServer("fd-sources");
  const feed = await import("../src/feed.js");
  const ALL_ON = { permissions: true, workDone: true, taskRuns: true, errors: true, context: true };
  try {
    assert.deepEqual(feed.feedSources(), ALL_ON, "no layout doc -> defaults");
    db.store.setKv(
      "dockview-layout",
      JSON.stringify({ settings: { feedSources: { errors: false, context: false } } }),
    );
    assert.deepEqual(feed.feedSources(), { ...ALL_ON, errors: false, context: false }, "partial settings merge");
    db.store.setKv("dockview-layout", "not json at all");
    assert.deepEqual(feed.feedSources(), ALL_ON, "corrupt JSON falls back to defaults");
    db.store.setKv("dockview-layout", JSON.stringify({ noSettings: true }));
    assert.deepEqual(feed.feedSources(), ALL_ON, "doc without settings.feedSources -> defaults");
  } finally {
    cleanup();
  }
});
