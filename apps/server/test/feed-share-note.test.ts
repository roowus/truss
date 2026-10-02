import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync as _mkd, writeFileSync as _wfs } from "node:fs";
import { tmpdir as _tmp } from "node:os";
import { join as _join } from "node:path";

/* hermetic HOME: practices.ts pins the global TRUSS.md at import time — on a
   dev box with a real one, first-prompt wrapping would prepend it to the
   shared message and break the exact-template pins below (CI never has one) */
process.env.HOME = _mkd(_join(_tmp(), "truss-fshare-home-"));

import { freshServer } from "./helpers.js";
import type { AdapterHandle, HarnessAdapter, SessionOpts } from "../src/adapters/types.js";

/* SPEC-TESTS for share-with-a-prompt — https://github.com/roowus/truss/issues/24
   ("The feed share button should let you type a prompt before you share").
   These FAIL on purpose today: they pin the contract a fix must satisfy.

   Today's share (index.ts:567-580 + FeedPanel's SharePop): pick a session →
   shareFeedItem() records it → sendPrompt() drops a FIXED template into the
   target chat ("**[shared from your feed]** <title>\n\n<body>"). No way to
   say what you want the receiving agent to DO with the card.

   The contract:

   - feed.ts gains a pure composeShareMessage(item, note?) — no note (or a
     whitespace-only one) returns EXACTLY today's template; with a note, the
     message carries the card (title + body) AND the note, verbatim, in its
     own marked section.
   - feed.ts gains shareFeedToSession(id, sessionId, note?) — the route's
     whole job as one call: record the share (sharedWith, once) AND prompt
     the target session with the composed message. Unknown item/session
     reject cleanly.

   The SharePop UI (a note field above the session list, Enter-to-share) is
   acceptance criteria, not here. */

interface FeedShareModule {
  composeShareMessage(item: { title: string; body?: string }, note?: string): string;
  shareFeedToSession(id: string, sessionId: string, note?: string): Promise<{ id: string }>;
}

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
  const rec: { sent: string[] } = { sent: [] };
  sessions.registerAdapter("fake-share" as never, fakeAdapter("fake-share", rec));
  const target = await sessions.createSession({ harness: "fake-share" as never, cwd: "/tmp", title: "ops session" });
  return { db, sessions, feed: feed as any, rec, target, cleanup: () => { sessions.unregisterAdapter("fake-share" as never); cleanup(); } };
}

/* today's exact template (index.ts:574) — the no-note guard */
const TODAY = (title: string, body?: string) => `**[shared from your feed]** ${title}${body ? `\n\n${body}` : ""}`;

test("composeShareMessage: no note (or a blank one) reproduces today's template exactly", async () => {
  const { cleanup } = await setup("share-compose");
  try {
    const feed = (await import("../src/feed.js")) as any;
    assert.equal(typeof feed.composeShareMessage, "function", "feed.ts must export composeShareMessage — see issue #24");
    assert.equal(feed.composeShareMessage({ title: "deploy failed", body: "exit 1" }), TODAY("deploy failed", "exit 1"), "no note → the fixed template, unchanged");
    assert.equal(feed.composeShareMessage({ title: "deploy failed" }), TODAY("deploy failed"), "no body either");
    assert.equal(feed.composeShareMessage({ title: "deploy failed" }, "   \n  "), TODAY("deploy failed"), "whitespace-only note is no note");
  } finally {
    cleanup();
  }
});

test("composeShareMessage: a note rides along, verbatim and clearly marked", async () => {
  const { cleanup } = await setup("share-compose-note");
  try {
    const feed = (await import("../src/feed.js")) as any;
    assert.equal(typeof feed.composeShareMessage, "function", "composeShareMessage must exist (see template test)");
    const msg = feed.composeShareMessage({ title: "deploy failed", body: "exit 1" }, "handle this tonight, rollback is fine");
    assert.ok(msg.includes("deploy failed") && msg.includes("exit 1"), "the card content is still there");
    assert.ok(msg.includes("handle this tonight, rollback is fine"), "the note is verbatim");
    assert.match(msg, /note|message|instruction/i, "the note is in a marked section, not silently concatenated");
    assert.notEqual(msg, TODAY("deploy failed", "exit 1"), "a note changes the message");
  } finally {
    cleanup();
  }
});

test("shareFeedToSession: records the share AND prompts the target with card + note", async () => {
  const { db, feed, rec, target, cleanup } = await setup("share-full");
  try {
    assert.equal(typeof feed.shareFeedToSession, "function", "feed.ts must export shareFeedToSession(id, sessionId, note?) — see issue #24");
    const item = feed.postFeed({ type: "error", title: "build broke", body: "tsc says no", dedupeKey: `test-${Date.now()}` }).item;

    await feed.shareFeedToSession(item.id, target.id, "please fix before standup");

    const shared = feed.getFeedItem(item.id);
    assert.ok(shared.sharedWith.includes(target.id), "sharedWith recorded");

    const wire = rec.sent.at(-1)!;
    assert.ok(wire.includes("build broke"), "the card title reached the chat");
    assert.ok(wire.includes("please fix before standup"), "the typed note reached the chat");
    assert.ok(wire.includes("tsc says no"), "the card body reached the chat");
  } finally {
    cleanup();
  }
});

test("shareFeedToSession without a note behaves exactly like today's share", async () => {
  const { feed, rec, target, cleanup } = await setup("share-plain");
  try {
    assert.equal(typeof feed.shareFeedToSession, "function", "shareFeedToSession must exist (see full test)");
    const item = feed.postFeed({ type: "note", title: "weekly report ready", dedupeKey: `test2-${Date.now()}` }).item;

    await feed.shareFeedToSession(item.id, target.id);
    const wire = rec.sent.at(-1)!;
    assert.equal(wire, TODAY("weekly report ready", undefined), "no note → today's fixed template verbatim");
    assert.ok(feed.getFeedItem(item.id).sharedWith.includes(target.id));
  } finally {
    cleanup();
  }
});

test("clean rejections: unknown item, unknown session", async () => {
  const { feed, cleanup } = await setup("share-edge");
  try {
    assert.equal(typeof feed.shareFeedToSession, "function", "shareFeedToSession must exist (see full test)");
    await assert.rejects(() => feed.shareFeedToSession("no-such-item", "anybody"), /no such feed item/i);
    const item = feed.postFeed({ type: "error", title: "x", dedupeKey: `test3-${Date.now()}` }).item;
    await assert.rejects(() => feed.shareFeedToSession(item.id, "no-such-session"), /no such session/i, "the prompt half surfaces the session error");
  } finally {
    cleanup();
  }
});

/* pins the new failure semantics: validation passed but the prompt itself
   blew up — the share must NOT be recorded (no phantom sharedWith) */
test("shareFeedToSession: a failed prompt leaves sharedWith untouched", async () => {
  const { db, cleanup } = await freshServer("share-failprompt");
  try {
    const sessions = await import("../src/sessions.js");
    const feed = (await import("../src/feed.js")) as any;
    const boom = fakeAdapter("fake-boom" as never, { sent: [] });
    boom.send = () => {
      throw new Error("harness died mid-send");
    };
    sessions.registerAdapter("fake-boom" as never, boom);
    const target = await sessions.createSession({ harness: "fake-boom" as never, cwd: "/tmp", title: "doomed session" });

    const item = feed.postFeed({ type: "error", title: "build broke", dedupeKey: `test4-${Date.now()}` }).item;
    await assert.rejects(() => feed.shareFeedToSession(item.id, target.id, "handle this"), /harness died mid-send/, "the prompt error surfaces");
    assert.ok(!feed.getFeedItem(item.id).sharedWith.includes(target.id), "failed share records no phantom sharedWith");

    sessions.unregisterAdapter("fake-boom" as never);
  } finally {
    cleanup();
  }
});
