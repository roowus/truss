import { randomUUID } from "node:crypto";
import type { HarnessId, ProtoEvent } from "@truss/proto";
import { store } from "./db.js";
import { piAdapter } from "./adapters/pi.js";
import type { AdapterHandle, HarnessAdapter } from "./adapters/types.js";

const adapters = new Map<HarnessId, HarnessAdapter>([[piAdapter.id, piAdapter]]);

interface LiveSession {
  adapter: HarnessAdapter;
  handle: AdapterHandle;
}

const live = new Map<string, LiveSession>();
let broadcastFn: (ev: ProtoEvent) => void = () => {};

export function setBroadcaster(fn: (ev: ProtoEvent) => void) {
  broadcastFn = fn;
}

/** Persist + fan out one event. The single sink every adapter event flows through. */
function sink(ev: ProtoEvent) {
  try {
    store.appendEvent(ev);
  } catch (err) {
    console.error("persist failed", err);
  }
  if (ev.type === "session.state") {
    store.setSessionState(ev.sessionId, ev.state);
  }
  broadcastFn(ev);
}

/**
 * On boot every previously-live session's harness process is gone.
 * Mark them closed; their transcripts stay replayable from the event store.
 */
export function reconcileOnBoot() {
  for (const s of store.listSessions()) {
    if (s.state === "spawning" || s.state === "running" || s.state === "idle") {
      store.setSessionState(s.id, "closed");
    }
  }
}

export async function createSession(input: {
  harness: HarnessId;
  cwd: string;
  model?: string;
  provider?: string;
  title?: string;
  project?: string;
}) {
  const adapter = adapters.get(input.harness);
  if (!adapter) throw new Error(`unknown harness: ${input.harness}`);

  const id = randomUUID().slice(0, 8);
  const title = input.title?.trim() || "new session";
  store.createSession({
    id,
    harness: input.harness,
    title,
    cwd: input.cwd,
    model: input.model,
    project: input.project,
  });

  sink({
    type: "session.created",
    sessionId: id,
    harness: input.harness,
    title,
    cwd: input.cwd,
    model: input.model,
    project: input.project,
    at: Date.now(),
  });

  const handle = await adapter.spawn({
    sessionId: id,
    cwd: input.cwd,
    model: input.model,
    provider: input.provider,
  });
  live.set(id, { adapter, handle });

  // pump adapter events into the sink
  void (async () => {
    for await (const ev of adapter.events(handle)) sink(ev);
  })();

  return store.getSession(id)!;
}

export function sendPrompt(sessionId: string, text: string) {
  const s = live.get(sessionId);
  if (!s) {
    const row = store.getSession(sessionId);
    if (!row) throw new Error(`no such session: ${sessionId}`);
    throw new Error(`session is ${row.state} — harness process not running`);
  }
  // the user bubble is a local echo: instant in UI, persisted like everything else
  const messageId = `u-${Date.now()}`;
  sink({ type: "msg.start", sessionId, messageId, role: "user", at: Date.now() });
  sink({ type: "msg.chunk", sessionId, messageId, text });
  sink({ type: "msg.done", sessionId, messageId });
  // auto-title from the first prompt
  const row = store.getSession(sessionId);
  if (row && row.title === "new session") {
    const title = text.replace(/\s+/g, " ").trim().slice(0, 48);
    if (title) store.setSessionTitle(sessionId, title);
  }
  s.adapter.send(s.handle, text);
}

export function interrupt(sessionId: string) {
  const s = live.get(sessionId);
  if (!s) throw new Error(`session not live: ${sessionId}`);
  s.adapter.interrupt(s.handle);
}

export function closeSession(sessionId: string) {
  const s = live.get(sessionId);
  if (s) {
    s.adapter.dispose(s.handle);
    live.delete(sessionId);
  }
  store.setSessionState(sessionId, "closed");
}

export function listHarnesses() {
  return [...adapters.values()].map((a) => ({
    id: a.id,
    capabilities: a.capabilities,
  }));
}

export async function listModels() {
  const out: { harness: string; provider: string; model: string; label: string }[] = [];
  for (const a of adapters.values()) {
    for (const m of await a.listModels()) out.push({ harness: a.id, ...m });
  }
  return out;
}

export function isLive(sessionId: string) {
  return live.has(sessionId);
}
