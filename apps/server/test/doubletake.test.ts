import { test } from "node:test";
import assert from "node:assert/strict";
import { freshServer } from "./helpers.js";

/* SPEC-TESTS for the doubletake integration — https://github.com/roowus/truss/issues/42
   ("The doubletake project running locally should also be integrated into
   truss"). These FAIL on purpose today: they pin the contract a fix must
   satisfy.

   Doubletake (running on this box, https://doubletake.rewis) is a self-hosted
   "share it now, get a researched answer later" app: an item queue
   (new → extracting → researching → answered | failed | capped) with a
   per-item research chat. Truss's feed is exactly where "your research is
   ready" belongs.

   The contract: a new src/integrations/doubletake.ts — a defensive client
   mapping its /api/chats wire shape (api/dto.ts toChatSummary) onto feed
   cards:

     parseDoubletakeChats(json: unknown): DtChat[]
       — wire data is hostile: never throws; non-array → []; entries without
         a string id are dropped; missing optionals default
         (title "Untitled", unreadCount 0, tags []).

     mapDoubletakeChat(chat): FeedCardInput | null
       — answered → a card (type "doubletake", dedupeKey "dt:<id>", title,
         body carries the sourceUrl link when known); unreadCount > 0 →
         importance "high", else "normal";
       — failed → a card with the failure marked in the title, importance
         "high";
       — capped → a card marked partial;
       — new / extracting / researching → null (in flight — don't nag).

     diffNewChats(knownIds: Set<string>, chats): DtChat[]
       — only chats whose id is NOT in knownIds; the caller stores the set
         so a poll never re-cards.

   Settings plumbing (baseUrl + token + poll toggle), the polling loop, and a
   possible PWA panel are acceptance criteria, not pinned here. */

interface DtChat {
  id: string;
  title: string;
  status: string;
  unreadCount: number;
  sourceUrl?: string;
  platform?: string;
  tags?: string[];
}
interface FeedCardInput {
  type: string;
  title: string;
  body?: string;
  importance: string;
  dedupeKey: string;
  data?: Record<string, unknown>;
}
interface DtModule {
  parseDoubletakeChats(json: unknown): DtChat[];
  mapDoubletakeChat(chat: DtChat): FeedCardInput | null;
  diffNewChats(knownIds: Set<string>, chats: DtChat[]): DtChat[];
}

async function load(): Promise<DtModule | null> {
  const spec = "../src/integrations/doubletake.js"; // variable specifier: typechecks before the module exists
  return import(spec).catch(() => null);
}

const CHAT: DtChat = {
  id: "chat-1",
  title: "Do celery seeds help with knee pain?",
  status: "answered",
  unreadCount: 1,
  sourceUrl: "https://instagram.com/reel/abc",
  platform: "instagram",
  tags: ["health"],
};

test("src/integrations/doubletake.ts exists; parseDoubletakeChats is bulletproof on the wire", async () => {
  const { cleanup } = await freshServer("dt-parse");
  try {
    const mod = await load();
    assert.ok(mod, "src/integrations/doubletake.ts must export parseDoubletakeChats/mapDoubletakeChat/diffNewChats — see issue #42");

    assert.deepEqual(mod.parseDoubletakeChats(null), []);
    assert.deepEqual(mod.parseDoubletakeChats({ nope: 1 }), []);
    assert.deepEqual(mod.parseDoubletakeChats([{ status: "answered" }, { id: 42 }, "junk"]), [], "id-less and non-object entries drop, never crash");
    const [one] = mod.parseDoubletakeChats([{ id: "c9", status: "answered" }]);
    assert.equal(one.id, "c9");
    assert.equal(one.title, "Untitled", "missing title defaults like doubletake's own dto");
    assert.equal(one.unreadCount, 0);
  } finally {
    cleanup();
  }
});

test("mapDoubletakeChat: answered → card with link; unread research is high-importance", async () => {
  const { cleanup } = await freshServer("dt-map");
  try {
    const mod = await load();
    assert.ok(mod, "doubletake module must exist (see parse test)");

    const card = mod.mapDoubletakeChat(CHAT)!;
    assert.ok(card, "answered research becomes a card");
    assert.equal(card.type, "doubletake");
    assert.equal(card.dedupeKey, "dt:chat-1", "dedupe by chat id — a poll never re-posts");
    assert.ok(card.title.includes("celery seeds"), "the item's title");
    assert.ok(card.body?.includes("https://instagram.com/reel/abc"), "the source link is in the body");
    assert.equal(card.importance, "high", "unread answer → high");
    assert.equal(card.data?.chatId, "chat-1");

    const read = mod.mapDoubletakeChat({ ...CHAT, unreadCount: 0 })!;
    assert.equal(read.importance, "normal", "already-read → normal");
  } finally {
    cleanup();
  }
});

test("mapDoubletakeChat: failed/capped card it; in-flight states stay silent", async () => {
  const { cleanup } = await freshServer("dt-states");
  try {
    const mod = await load();
    assert.ok(mod, "doubletake module must exist (see parse test)");

    const failed = mod.mapDoubletakeChat({ ...CHAT, id: "f1", status: "failed" })!;
    assert.ok(failed, "failed research still cards (the user needs to know)");
    assert.match(failed.title, /fail/i, "the failure is visible in the title");
    assert.equal(failed.importance, "high");

    const capped = mod.mapDoubletakeChat({ ...CHAT, id: "c1", status: "capped" })!;
    assert.ok(capped, "capped (partial) research cards too");
    assert.match(capped.title + (capped.body ?? ""), /partial|cap/i, "partial result is marked");

    for (const busy of ["new", "extracting", "researching"]) {
      assert.equal(mod.mapDoubletakeChat({ ...CHAT, status: busy }), null, `${busy}: in flight, stay silent`);
    }
  } finally {
    cleanup();
  }
});

test("diffNewChats: only unseen ids; re-polling the same set yields nothing", async () => {
  const { cleanup } = await freshServer("dt-diff");
  try {
    const mod = await load();
    assert.ok(mod, "doubletake module must exist (see parse test)");

    const chats = [CHAT, { ...CHAT, id: "chat-2" }, { ...CHAT, id: "chat-3" }];
    const known = new Set<string>();
    const first = mod.diffNewChats(known, chats);
    assert.deepEqual(first.map((c) => c.id).sort(), ["chat-1", "chat-2", "chat-3"], "first poll: all new");
    for (const c of first) known.add(c.id);
    assert.deepEqual(mod.diffNewChats(known, chats), [], "second poll: nothing re-cards");
    assert.deepEqual(mod.diffNewChats(known, [...chats, { ...CHAT, id: "chat-4" }]).map((c) => c.id), ["chat-4"], "only the newcomer");
  } finally {
    cleanup();
  }
});
