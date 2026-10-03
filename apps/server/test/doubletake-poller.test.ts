import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { freshServer } from "./helpers.js";

/* The polling half of the doubletake integration (issue #42): /api/chats is
   faked with a local http server; the poller must post one feed card per
   newly finished chat, stay silent on in-flight items, card a chat that
   flips from in-flight to finished (audit round 1, B1), archive ancient
   backlog on first enable instead of flooding the inbox (B2), never re-card
   on the next poll or after a restart, and send the bearer token. */

test("doubletake poller: lifecycle against a fake /api/chats", async () => {
  const { cleanup } = await freshServer("dt-poll");
  const requests: { auth?: string }[] = [];
  const chats: unknown[] = [
    { id: "c0", title: "Ancient history", status: "answered", unreadCount: 0, lastMessageAt: "2020-01-01T00:00:00Z" },
    { id: "c1", title: "Knee pain and celery seeds", status: "answered", unreadCount: 2, sourceUrl: "https://example.com/reel" },
    { id: "c2", title: "Still cooking", status: "researching", unreadCount: 0 },
    { id: "c3", title: "Doomed item", status: "failed", unreadCount: 0 },
  ];
  const srv = createServer((req: IncomingMessage, res) => {
    requests.push({ auth: typeof req.headers.authorization === "string" ? req.headers.authorization : undefined });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(chats));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

  try {
    const dt = await import("../src/integrations/doubletake.js");
    const feed = await import("../src/feed.js");
    const settings = { enabled: true, baseUrl, token: "sekrit" };
    const known = new Set<string>();
    const dtCards = () => feed.listFeed({ limit: 500 }).filter((i) => i.type === "doubletake");

    /* poll 1 = first enable: recent/undated finished chats card, the stale
       one is archived to done, in-flight stays silent */
    const first = await dt.pollDoubletakeOnce(known, { settings });
    assert.equal(first, 2, "c1 + c3 card; c0 is stale backlog, c2 is in flight");
    assert.equal(requests[0].auth, "Bearer sekrit", "bearer token goes out");
    const byChat = (id: string) => dtCards().find((c) => c.data.chatId === id);
    assert.equal(byChat("c0")?.state, "done", "ancient backlog archives without nagging");
    assert.equal(byChat("c1")?.state, "unread");
    assert.equal(byChat("c1")?.data.chatUrl, `${baseUrl}/chat/c1`, "the card links out to the doubletake chat");
    assert.equal(byChat("c1")?.importance, "high", "unread answer is high importance");
    assert.equal(byChat("c2"), undefined, "researching: no card yet");

    assert.equal(await dt.pollDoubletakeOnce(known, { settings }), 0, "re-poll: nothing re-cards");

    /* B1: a chat first seen in flight must card when it finishes */
    chats[2] = { id: "c2", title: "Still cooking", status: "answered", unreadCount: 1 };
    assert.equal(await dt.pollDoubletakeOnce(known, { settings }), 1, "c2 flipped to answered and cards");
    assert.equal(byChat("c2")?.state, "unread");

    /* restart with a fresh seen-set: dedupe keys (including the archived
       backlog) suppress everything already recorded; only the newcomer cards */
    chats.push({ id: "c4", title: "Late answer", status: "answered", unreadCount: 0 });
    assert.equal(await dt.pollDoubletakeOnce(new Set(), { settings }), 1, "restart re-poll: only the newcomer cards");
    assert.equal(dtCards().length, 5, "c0 archived + c1/c2/c3/c4 carded, no dupes");

    assert.equal(await dt.pollDoubletakeOnce(new Set(), { settings: { ...settings, enabled: false } }), 0, "disabled: no work");
    assert.equal(requests.length, 4, "disabled poll never hit the endpoint");
  } finally {
    await new Promise((r) => srv.close(r));
    cleanup();
  }
});

/* B4 + B5: the layout-doc settings seam is pinned, and a non-http(s) base
   URL (the doc is agent-writable) reads as unset. */
test("doubletakeSettings: reads the client's snapshot shape, refuses bad schemes", async () => {
  const { db, cleanup } = await freshServer("dt-settings");
  try {
    const dt = await import("../src/integrations/doubletake.js");
    const doc = (doubletake: unknown) =>
      JSON.stringify({
        version: 2,
        activeId: "main",
        spaces: [{ id: "main", name: "Main", layout: null }],
        settings: { doubletake },
      });

    db.store.setKv("dockview-layout", doc({ enabled: true, baseUrl: "https://doubletake.rewis/", token: "tok" }));
    assert.deepEqual(dt.doubletakeSettings(), { enabled: true, baseUrl: "https://doubletake.rewis", token: "tok" }, "trailing slash stripped, triple parsed");

    db.store.setKv("dockview-layout", doc({ enabled: true, baseUrl: "javascript:alert(1)", token: "x" }));
    assert.equal(dt.doubletakeSettings().baseUrl, "", "non-http(s) base URL reads as unset (polling stays off)");

    db.store.setKv("dockview-layout", "not json");
    assert.deepEqual(dt.doubletakeSettings(), { enabled: false, baseUrl: "", token: "" }, "garbage doc: off by default");
  } finally {
    cleanup();
  }
});
