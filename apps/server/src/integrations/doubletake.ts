import { store } from "../db.js";
import { postFeed } from "../feed.js";

/**
 * Doubletake integration — "your research is ready" cards in the feed.
 *
 * Doubletake (https://github.com/roowus/doubletake) runs on this box: you
 * share a post/link/text, a brain researches it, and the item lands in a
 * per-item chat. Its `/api/chats` (bearer auth) returns ChatSummary items
 * whose status walks new → extracting → researching → answered | failed |
 * capped. A server-side poller diffs that list and posts one feed card per
 * finished chat (dedupe `dt:<chatId>`); in-flight items stay silent.
 *
 * Settings live in the layout doc (same place as feedSources):
 *   settings.doubletake = { enabled, baseUrl, token }
 *
 * The pure mapping half (parseDoubletakeChats / mapDoubletakeChat /
 * diffNewChats) is the contract pinned by test/doubletake.test.ts — change
 * those only together with the tests.
 */

export interface DtChat {
  id: string;
  title: string;
  status: string;
  unreadCount: number;
  sourceUrl?: string;
  platform?: string;
  tags?: string[];
}

export interface FeedCardInput {
  type: string;
  title: string;
  body?: string;
  importance: string;
  dedupeKey: string;
  data?: Record<string, unknown>;
}

export interface DtSettings {
  enabled: boolean;
  baseUrl: string;
  token: string;
}

/** Wire data is hostile: never throws, drops anything without a string id. */
export function parseDoubletakeChats(json: unknown): DtChat[] {
  if (!Array.isArray(json)) return [];
  const out: DtChat[] = [];
  for (const raw of json) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    if (typeof c.id !== "string" || !c.id) continue;
    out.push({
      id: c.id,
      title: typeof c.title === "string" && c.title ? c.title : "Untitled",
      status: typeof c.status === "string" ? c.status : "new",
      unreadCount: typeof c.unreadCount === "number" && Number.isFinite(c.unreadCount) ? c.unreadCount : 0,
      sourceUrl: typeof c.sourceUrl === "string" ? c.sourceUrl : undefined,
      platform: typeof c.platform === "string" ? c.platform : undefined,
      tags: Array.isArray(c.tags) ? c.tags.filter((t): t is string => typeof t === "string") : [],
    });
  }
  return out;
}

/** A finished chat becomes a feed card; in-flight states stay silent. */
export function mapDoubletakeChat(chat: DtChat): FeedCardInput | null {
  const importance = chat.unreadCount > 0 ? "high" : "normal";
  const sourceLine = chat.sourceUrl ? `Source: ${chat.sourceUrl}` : undefined;
  const base: FeedCardInput = {
    type: "doubletake",
    title: chat.title,
    importance,
    dedupeKey: `dt:${chat.id}`,
    data: {
      chatId: chat.id,
      status: chat.status,
      ...(chat.sourceUrl ? { sourceUrl: chat.sourceUrl } : {}),
      ...(chat.platform ? { platform: chat.platform } : {}),
      ...(chat.tags?.length ? { tags: chat.tags } : {}),
    },
  };

  switch (chat.status) {
    case "answered":
      return { ...base, body: sourceLine };
    case "failed":
      /* a failure needs attention even when already read */
      return {
        ...base,
        title: `Research failed: ${chat.title}`,
        body: [sourceLine, "Doubletake could not finish this one."].filter(Boolean).join("\n\n"),
        importance: "high",
      };
    case "capped":
      return {
        ...base,
        title: `Partial research: ${chat.title}`,
        body: [sourceLine, "Doubletake stopped early — the answer is partial (capped)."].filter(Boolean).join("\n\n"),
      };
    default:
      /* new / extracting / researching / anything unknown: in flight, don't nag */
      return null;
  }
}

/** Only chats the caller has not seen yet — the caller owns the set. */
export function diffNewChats(knownIds: Set<string>, chats: DtChat[]): DtChat[] {
  return chats.filter((c) => !knownIds.has(c.id));
}

/* ── the poller ── */

const POLL_MS = 60_000;

/** Settings from the layout doc, next to feedSources. Off by default. */
export function doubletakeSettings(): DtSettings {
  const def: DtSettings = { enabled: false, baseUrl: "", token: "" };
  try {
    const raw = store.getKv("dockview-layout");
    if (!raw) return def;
    const doc = JSON.parse(raw);
    const d = doc?.settings?.doubletake ?? {};
    return {
      enabled: d.enabled === true,
      baseUrl: typeof d.baseUrl === "string" ? d.baseUrl.replace(/\/+$/, "") : "",
      token: typeof d.token === "string" ? d.token : "",
    };
  } catch {
    return def;
  }
}

/**
 * One poll: fetch /api/chats, post a card per newly finished chat. Returns
 * the number of cards posted. Dedupe is double-locked: the in-memory
 * knownIds set skips re-work within a run, and postFeed's dedupeKey
 * (dt:<chatId>, UNIQUE) makes a restart re-poll harmless.
 */
export async function pollDoubletakeOnce(
  knownIds: Set<string>,
  opts: { settings?: DtSettings; fetchImpl?: typeof fetch } = {},
): Promise<number> {
  const cfg = opts.settings ?? doubletakeSettings();
  if (!cfg.enabled || !cfg.baseUrl) return 0;
  const fetcher = opts.fetchImpl ?? fetch;
  const res = await fetcher(`${cfg.baseUrl}/api/chats`, {
    headers: cfg.token ? { authorization: `Bearer ${cfg.token}` } : {},
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`doubletake /api/chats answered ${res.status}`);
  const fresh = diffNewChats(knownIds, parseDoubletakeChats(await res.json()));
  let posted = 0;
  for (const chat of fresh) {
    knownIds.add(chat.id);
    const card = mapDoubletakeChat(chat);
    if (!card) continue;
    const { created } = postFeed({
      ...card,
      type: "doubletake",
      importance: card.importance as "low" | "normal" | "high" | "urgent",
      data: { ...card.data, chatUrl: `${cfg.baseUrl}/chat/${chat.id}` },
    });
    if (created) posted++;
  }
  return posted;
}

/** Start the poll loop; returns a stop function. Silent when disabled. */
export function startDoubletakePoll(intervalMs = POLL_MS): () => void {
  const knownIds = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const arm = (ms: number) => {
    timer = setTimeout(() => void round(), ms);
    /* never hold the event loop open (tests boot the whole server) */
    timer.unref?.();
  };

  const round = async () => {
    if (stopped) return;
    try {
      await pollDoubletakeOnce(knownIds);
    } catch {
      /* doubletake down or misconfigured: try again next tick, stay quiet */
    }
    if (!stopped) arm(intervalMs);
  };
  /* first poll shortly after boot, then once a minute */
  arm(5_000);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
