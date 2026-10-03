import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { freshServer } from "./helpers.js";

/* The polling half of the doubletake integration (issue #42): /api/chats is
   faked with a local http server; the poller must post one feed card per
   newly finished chat, stay silent on in-flight items, never re-card on the
   next poll, and send the bearer token when configured. */

test("doubletake poller: finished research cards once, in-flight stays silent, bearer sent", async () => {
  const { cleanup } = await freshServer("dt-poll");
  const requests: { auth?: string }[] = [];
  let chats: unknown[] = [
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

    const first = await dt.pollDoubletakeOnce(known, { settings });
    assert.equal(first, 2, "answered + failed card; the researching one stays silent");
    assert.equal(requests[0].auth, "Bearer sekrit", "bearer token goes out");

    const cards = feed.listFeed().filter((i) => i.type === "doubletake");
    assert.deepEqual(cards.map((c) => c.data.chatId).sort(), ["c1", "c3"]);
    const c1 = cards.find((c) => c.data.chatId === "c1")!;
    assert.equal(c1.data.chatUrl, `${baseUrl}/chat/c1`, "the card links out to the doubletake chat");
    assert.equal(c1.importance, "high", "unread answer is high importance");

    assert.equal(await dt.pollDoubletakeOnce(known, { settings }), 0, "re-poll: nothing re-cards");

    /* a chat that flips to answered later still cards (dedupe key, not the
       in-memory set, is what survives a restart — simulate with fresh set) */
    chats = [...chats, { id: "c4", title: "Late answer", status: "answered", unreadCount: 0 }];
    const afterRestart = new Set<string>();
    assert.equal(await dt.pollDoubletakeOnce(afterRestart, { settings }), 1, "restart re-poll: only the newcomer cards");
    assert.equal(feed.listFeed().filter((i) => i.type === "doubletake").length, 3);

    assert.equal(await dt.pollDoubletakeOnce(new Set(), { settings: { ...settings, enabled: false } }), 0, "disabled: no work");
    assert.equal(requests.length, 3, "disabled poll never hit the endpoint");
  } finally {
    await new Promise((r) => srv.close(r));
    cleanup();
  }
});
