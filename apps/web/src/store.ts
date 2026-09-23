import { useSyncExternalStore } from "react";
import type { ProtoEvent } from "@truss/proto";
import { api, type EventFrame, type ModelInfo, type SessionMeta } from "./api";

/* ── derived per-session shapes ── */

export interface ChatEntry {
  kind: "msg" | "tool";
  id: string;
  role?: "user" | "assistant" | "system";
  text?: string;
  thinking?: string;
  done?: boolean;
  streaming?: boolean;
  stopReason?: string;
  name?: string;
  args?: unknown;
  status?: "in_progress" | "done";
  ok?: boolean;
  durationMs?: number;
  output?: string;
  at: number;
}

export interface CallRow {
  callId: string;
  model: string;
  at: number;
  done: boolean;
  status?: number;
  latencyMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  retryOf?: string;
}

interface CtxState {
  used: number;
  total: number;
  by?: { system?: number; tools?: number; rules?: number; memory?: number; conversation?: number };
}

interface SessionData {
  entries: ChatEntry[];
  calls: CallRow[];
  ctx: CtxState | null;
  /** highest applied event-log rowid — replay vs live dedupe */
  lastSeq: number;
  /** events have been fetched at least once (else WS-only gaps possible) */
  hydrated: boolean;
}

/* ── store ── */

class TrussStore {
  sessions = new Map<string, SessionMeta>();
  data = new Map<string, SessionData>();
  models: ModelInfo[] = [];
  wsState: "connecting" | "open" | "closed" = "connecting";

  private listeners = new Set<() => void>();
  private version = 0;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = () => this.version;

  private bump() {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  /** public invalidation for non-event state (ws status) */
  touch() {
    this.bump();
  }

  /** refresh the sessions list (e.g. after server-side auto-title) */
  async refreshSessions() {
    const { sessions } = await api.sessions();
    for (const row of sessions) this.sessions.set(row.id, row);
    this.bump();
  }

  private sessionData(id: string): SessionData {
    let d = this.data.get(id);
    if (!d) {
      d = { entries: [], calls: [], ctx: null, lastSeq: 0, hydrated: false };
      this.data.set(id, d);
    }
    return d;
  }

  /* ── loading ── */

  async init() {
    const [{ sessions }, { models }] = await Promise.all([api.sessions(), api.harnesses()]);
    this.models = models;
    for (const s of sessions) this.sessions.set(s.id, s);
    this.bump();
  }

  /** Fetch full event history for a session once; live events stream in after. */
  async hydrate(sessionId: string) {
    const d = this.sessionData(sessionId);
    if (d.hydrated) return;
    d.hydrated = true;
    try {
      const { events } = await api.events(sessionId);
      for (const f of events) this.applyFrame(f, true);
      this.bump();
    } catch {
      d.hydrated = false;
    }
  }

  /** one wire frame; frames at or below lastSeq were already applied (replay/live overlap) */
  applyFrame(frame: EventFrame, defer = false) {
    const d = this.sessionData(frame.ev.sessionId);
    if (frame.seq > 0 && frame.seq <= d.lastSeq) return;
    if (frame.seq > d.lastSeq) d.lastSeq = frame.seq;
    this.applyEvent(frame.ev, defer);
  }

  /* ── event application ── */

  applyEvent(ev: ProtoEvent, defer = false) {
    switch (ev.type) {
      case "session.created": {
        /* live creation path only — on replay the REST row (with its real
           current state) is already in the map and must win */
        if (!this.sessions.has(ev.sessionId)) {
          this.sessions.set(ev.sessionId, {
            id: ev.sessionId,
            harness: ev.harness,
            title: ev.title,
            cwd: ev.cwd,
            model: ev.model ?? null,
            project: ev.project ?? null,
            state: "spawning",
            created_at: ev.at,
            updated_at: ev.at,
            live: true,
          });
        }
        break;
      }
      case "session.state": {
        const s = this.sessions.get(ev.sessionId);
        /* closed is terminal client-side: replayed history must not resurrect a session */
        if (s && s.state !== "closed") {
          this.sessions.set(ev.sessionId, { ...s, state: ev.state, updated_at: Date.now() });
        }
        break;
      }
      case "msg.start": {
        const d = this.sessionData(ev.sessionId);
        d.entries.push({
          kind: "msg",
          id: ev.messageId,
          role: ev.role,
          text: "",
          thinking: "",
          done: false,
          streaming: ev.role === "assistant",
          at: ev.at,
        });
        break;
      }
      case "msg.chunk": {
        const d = this.sessionData(ev.sessionId);
        const m = d.entries.find((e) => e.kind === "msg" && e.id === ev.messageId);
        if (m) {
          if (ev.channel === "thinking") m.thinking = (m.thinking ?? "") + ev.text;
          else m.text = (m.text ?? "") + ev.text;
        }
        break;
      }
      case "msg.done": {
        const d = this.sessionData(ev.sessionId);
        const m = d.entries.find((e) => e.kind === "msg" && e.id === ev.messageId);
        if (m) {
          m.done = true;
          m.streaming = false;
          m.stopReason = ev.stopReason;
          // a completed user message may have triggered server-side auto-title
          if (m.role === "user") void this.refreshSessions();
        }
        break;
      }
      case "tool.call": {
        const d = this.sessionData(ev.sessionId);
        d.entries.push({
          kind: "tool",
          id: ev.toolCallId,
          name: ev.name,
          args: ev.args,
          status: "in_progress",
          at: Date.now(),
        });
        break;
      }
      case "tool.update": {
        const d = this.sessionData(ev.sessionId);
        const t = d.entries.find((e) => e.kind === "tool" && e.id === ev.toolCallId);
        if (t) t.output = ev.output ?? t.output;
        break;
      }
      case "tool.done": {
        const d = this.sessionData(ev.sessionId);
        const t = d.entries.find((e) => e.kind === "tool" && e.id === ev.toolCallId);
        if (t) {
          t.status = "done";
          t.ok = ev.ok;
          t.durationMs = ev.durationMs;
          t.output = ev.output ?? t.output;
        }
        break;
      }
      case "llm.call.start": {
        const d = this.sessionData(ev.sessionId);
        d.calls.push({ callId: ev.callId, model: ev.model, at: ev.at, done: false });
        break;
      }
      case "llm.call.done": {
        const d = this.sessionData(ev.sessionId);
        const c = d.calls.find((r) => r.callId === ev.callId);
        if (c) {
          c.done = true;
          c.status = ev.status;
          c.latencyMs = ev.latencyMs;
          c.tokensIn = ev.tokensIn;
          c.tokensOut = ev.tokensOut;
          c.costUsd = ev.costUsd;
          c.retryOf = ev.retryOf;
        }
        break;
      }
      case "ctx.usage": {
        const d = this.sessionData(ev.sessionId);
        d.ctx = { used: ev.used, total: ev.total, by: ev.by };
        break;
      }
      default:
        return; // perm/subagent events land in later milestones
    }
    if (!defer) this.bump();
  }
}

export const store = new TrussStore();

/* ── WS wiring with auto-reconnect ── */

let ws: WebSocket | null = null;
export function connectEvents() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/events`);
  ws.onopen = () => {
    store.wsState = "open";
    store.touch();
  };
  ws.onmessage = (e) => {
    try {
      store.applyFrame(JSON.parse(e.data) as EventFrame);
    } catch {
      /* malformed frame — ignore */
    }
  };
  ws.onclose = () => {
    store.wsState = "closed";
    store.touch();
    setTimeout(connectEvents, 1500);
  };
}

/* ── react binding ── */

export function useStore(): TrussStore {
  useSyncExternalStore(store.subscribe, store.getVersion);
  return store;
}

/** the store's mutation counter — use as an effect dep to react to any change */
export function useStoreVersion(): number {
  return useSyncExternalStore(store.subscribe, store.getVersion);
}

export function fmtTokens(n?: number): string {
  if (n == null) return "—";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function fmtAge(updatedAt: number): string {
  const m = Math.max(0, Math.floor((Date.now() - updatedAt) / 60000));
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
