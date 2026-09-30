import { useSyncExternalStore, useRef, useCallback, useEffect, useState } from "react";
import type { Backend, ConnStatus } from "./backend";
import type {
  AgentInfo,
  CreateSessionBody,
  FeedItem,
  Frame,
  HarnessInfo,
  HostInfo,
  ModelInfo,
  ProtoEvent,
  SessionMeta,
  TerminalInfo,
  TodoItem,
} from "./proto";

export const toMs = (at: string | number | undefined): number => {
  if (at === undefined || at === null) return Date.now();
  if (typeof at === "number") return at < 1e12 ? at * 1000 : at;
  const n = Date.parse(at);
  return Number.isNaN(n) ? Date.now() : n;
};

/* ---------------- view model ---------------- */
export interface Segment { channel: string; text: string }
export interface Msg { id: string; role: "user" | "assistant" | "system"; segments: Segment[]; done: boolean; stopReason?: string; at: number }
export interface ToolRun { id: string; name: string; args: unknown; callId?: string; output?: string; status: "running" | "ok" | "fail"; durationMs?: number; startedAt: number }
export interface Perm { requestId: string; tool: string; reason: string; options: string[]; choice?: string; at: number }
export interface Call {
  callId: string; model: string; at: number; index: number; done: boolean;
  status?: number; latencyMs?: number; tokensIn?: number; tokensOut?: number; costUsd?: number;
  cacheRead?: number; cacheWrite?: number; retryOf?: string;
  tools: string[];
}
export interface Agent { agentId: string; label: string; parent?: string; done: boolean; ok?: boolean; at: number; endedAt?: number }
export type Item = { kind: "msg" | "tool" | "perm"; id: string };

export interface SessionView {
  lastSeq: number;
  hydration: "loading" | "ready" | "error";
  hydrationError?: string;
  items: Item[];
  msgs: Record<string, Msg>;
  tools: Record<string, ToolRun>;
  perms: Record<string, Perm>;
  pending: string[];
  calls: Record<string, Call>;
  callOrder: string[];
  agents: Record<string, Agent>;
  agentOrder: string[];
  ctx?: { used: number; total: number; by?: Record<string, number> };
  ctxHistory: { t: number; used: number; total: number }[];
  stateDetail?: string;
}

export const emptyView = (): SessionView => ({
  lastSeq: 0, hydration: "loading", items: [], msgs: {}, tools: {}, perms: {}, pending: [],
  calls: {}, callOrder: [], agents: {}, agentOrder: [], ctxHistory: [],
});

export interface Toast { id: number; kind: "error" | "info" | "ok"; title: string; body?: string }

export interface AppState {
  backend: Backend | null;
  conn: ConnStatus;
  everConnected: boolean;
  harnesses: HarnessInfo[];
  models: ModelInfo[];
  agents: AgentInfo[];
  agentsError?: string;
  sessions: Record<string, SessionMeta>;
  order: string[];
  sessionsLoaded: boolean;
  sessionsError?: string;
  views: Record<string, SessionView>;
  stateSince: Record<string, number>;
  terminals: TerminalInfo[];
  todos: Record<string, TodoItem>;
  todosLoaded: boolean;
  hosts: HostInfo[];
  hostsLoaded: boolean;
  feed: Record<string, FeedItem>;
  feedLoaded: boolean;
  toasts: Toast[];
  /** the 30-day trash (recently deleted) — restored or purged from the sidebar */
  trash: SessionMeta[];
  focused?: string;
  bootError?: string;
}

/* ---------------- reducer (pure-ish, copy-on-write) ---------------- */
export function reduce(v: SessionView, ev: ProtoEvent, frameTime: number): SessionView {
  switch (ev.type) {
    case "msg.start": {
      if (v.msgs[ev.messageId]) return v;
      return {
        ...v,
        msgs: { ...v.msgs, [ev.messageId]: { id: ev.messageId, role: ev.role, segments: [], done: false, at: toMs(ev.at) } },
        items: [...v.items, { kind: "msg", id: ev.messageId }],
      };
    }
    case "msg.chunk": {
      let m = v.msgs[ev.messageId];
      let items = v.items;
      if (!m) {
        m = { id: ev.messageId, role: "assistant", segments: [], done: false, at: frameTime };
        items = [...items, { kind: "msg", id: ev.messageId }];
      }
      const ch = ev.channel === "thinking" ? "thinking" : ev.channel || "text";
      const segs = m.segments.slice();
      const last = segs[segs.length - 1];
      if (last && last.channel === ch) segs[segs.length - 1] = { channel: ch, text: last.text + ev.text };
      else segs.push({ channel: ch, text: ev.text });
      return { ...v, items, msgs: { ...v.msgs, [m.id]: { ...m, segments: segs } } };
    }
    case "msg.done": {
      const m = v.msgs[ev.messageId];
      if (!m) return v;
      return { ...v, msgs: { ...v.msgs, [m.id]: { ...m, done: true, stopReason: ev.stopReason } } };
    }
    case "tool.call": {
      if (v.tools[ev.toolCallId]) return v;
      const t: ToolRun = { id: ev.toolCallId, name: ev.name, args: ev.args, callId: ev.callId, status: "running", startedAt: frameTime };
      let calls = v.calls;
      let cid = ev.callId && v.calls[ev.callId] ? ev.callId : undefined;
      if (!cid) {
        // fallback: attribute to the most recent open call (or the most recent call)
        for (let i = v.callOrder.length - 1; i >= 0; i--) if (!v.calls[v.callOrder[i]].done) { cid = v.callOrder[i]; break; }
        cid = cid ?? v.callOrder[v.callOrder.length - 1];
      }
      if (cid) calls = { ...calls, [cid]: { ...calls[cid], tools: [...calls[cid].tools, t.id] } };
      return { ...v, calls, tools: { ...v.tools, [t.id]: t }, items: [...v.items, { kind: "tool", id: t.id }] };
    }
    case "tool.update": {
      const t = v.tools[ev.toolCallId];
      if (!t || ev.output === undefined) return v;
      return { ...v, tools: { ...v.tools, [t.id]: { ...t, output: ev.output } } };
    }
    case "tool.done": {
      const t = v.tools[ev.toolCallId];
      if (!t) return v;
      return {
        ...v,
        tools: {
          ...v.tools,
          [t.id]: { ...t, status: ev.ok ? "ok" : "fail", durationMs: ev.durationMs ?? frameTime - t.startedAt, output: ev.output ?? t.output },
        },
      };
    }
    case "perm.request": {
      if (v.perms[ev.requestId]) return v;
      return {
        ...v,
        perms: { ...v.perms, [ev.requestId]: { requestId: ev.requestId, tool: ev.tool, reason: ev.reason, options: ev.options, at: frameTime } },
        pending: [...v.pending, ev.requestId],
        items: [...v.items, { kind: "perm", id: ev.requestId }],
      };
    }
    case "perm.resolve": {
      const p = v.perms[ev.requestId];
      return {
        ...v,
        perms: p ? { ...v.perms, [p.requestId]: { ...p, choice: ev.choice } } : v.perms,
        pending: v.pending.filter((r) => r !== ev.requestId),
      };
    }
    case "llm.call.start": {
      if (v.calls[ev.callId]) return v;
      return {
        ...v,
        calls: { ...v.calls, [ev.callId]: { callId: ev.callId, model: ev.model, at: toMs(ev.at), index: v.callOrder.length + 1, done: false, tools: [] } },
        callOrder: [...v.callOrder, ev.callId],
      };
    }
    case "llm.call.done": {
      const c = v.calls[ev.callId];
      if (!c) return v;
      return {
        ...v,
        calls: {
          ...v.calls,
          [c.callId]: { ...c, done: true, status: ev.status, latencyMs: ev.latencyMs, tokensIn: ev.tokensIn, tokensOut: ev.tokensOut, costUsd: ev.costUsd, cacheRead: ev.cacheRead, cacheWrite: ev.cacheWrite, retryOf: ev.retryOf },
        },
      };
    }
    case "subagent.spawn": {
      if (v.agents[ev.agentId]) return v;
      return {
        ...v,
        agents: { ...v.agents, [ev.agentId]: { agentId: ev.agentId, label: ev.label, parent: ev.parentAgentId, done: false, at: frameTime } },
        agentOrder: [...v.agentOrder, ev.agentId],
      };
    }
    case "subagent.done": {
      const a = v.agents[ev.agentId];
      if (!a) return v;
      return { ...v, agents: { ...v.agents, [a.agentId]: { ...a, done: true, ok: ev.ok, endedAt: frameTime } } };
    }
    case "ctx.usage":
      return {
        ...v,
        ctx: { used: ev.used, total: ev.total, by: ev.by },
        ctxHistory: [...v.ctxHistory, { t: frameTime, used: ev.used, total: ev.total }].slice(-200),
      };
    case "session.state":
      return { ...v, stateDetail: ev.detail };
    default:
      return v;
  }
}

/* ---------------- store ---------------- */
class Store {
  state: AppState = {
    backend: null,
    conn: { kind: "connecting", attempt: 0 },
    everConnected: false,
    harnesses: [],
    models: [],
    agents: [],
    sessions: {},
    order: [],
    sessionsLoaded: false,
    views: {},
    stateSince: {},
    terminals: [],
    todos: {},
    todosLoaded: false,
    hosts: [],
    hostsLoaded: false,
    feed: {},
    feedLoaded: false,
    toasts: [],
    trash: [],
  };
  private subs = new Set<() => void>();
  private raf = 0;
  private buffers: Record<string, Frame[]> = {};
  private refreshTimer: number | undefined;
  private toastN = 0;
  private unsubBus?: () => void;

  subscribe = (fn: () => void) => {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  };
  private notify() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.subs.forEach((s) => s());
    });
  }
  set(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
    const p = typeof patch === "function" ? patch(this.state) : patch;
    this.state = { ...this.state, ...p };
    this.notify();
  }
  get be() {
    if (!this.state.backend) throw new Error("backend not ready");
    return this.state.backend;
  }

  /* ---------- boot ---------- */
  async init(backend: Backend) {
    this.set({ backend });
    this.unsubBus?.();
    this.unsubBus = backend.connectEvents(
      (f) => this.onFrame(f),
      (s) => this.onConn(s),
    );
    await Promise.all([
      backend.harnesses().then((r) => this.set({ harnesses: r.harnesses, models: r.models })).catch((e) =>
        this.toast("error", "Couldn't load harnesses", String(e.message ?? e)),
      ),
      this.refreshAgents(),
      this.refreshSessions(),
      this.refreshTerminals(),
      this.refreshTodos(),
      this.refreshFeed(),
      this.refreshHosts(),
    ]);
    // Active sessions may have pending permission cards — hydrate them eagerly.
    for (const id of this.state.order) {
      const s = this.state.sessions[id];
      if (s.state === "running" || s.state === "spawning") void this.ensureHydrated(id);
    }
  }

  private onConn(s: ConnStatus) {
    /* "connecting" follows every "closed" in the reconnect cycle, so checking
       only for "closed" here made the resync dead code. The first-ever
       connect is excluded via everConnected (the boot fetch already ran). */
    const wasDown = this.state.conn.kind === "closed" || this.state.conn.kind === "connecting";
    const wasEverUp = this.state.everConnected;
    this.set({ conn: s, everConnected: wasEverUp || s.kind === "open" });
    if (s.kind === "open" && wasDown && wasEverUp) {
      this.toast("ok", "Event bus reconnected", "Resyncing sessions — events missed while offline are being replayed.");
      void this.resync();
    }
  }

  async resync() {
    await this.refreshSessions();
    await this.refreshTerminals();
    await this.refreshAgents();
    await Promise.all([this.refreshTodos(), this.refreshFeed(), this.refreshHosts(), this.refreshTrash()]);
    for (const id of Object.keys(this.state.views)) {
      if (this.state.sessions[id]) void this.rehydrate(id);
    }
  }

  async refreshAgents() {
    try {
      const { agents } = await this.be.agents();
      this.set({ agents, agentsError: undefined });
    } catch (e: any) {
      this.set({ agentsError: e?.message ?? String(e) });
      this.toast("error", "Could not load remote hosts", e?.message ?? String(e));
    }
  }

  async refreshHarnesses() {
    try {
      const { harnesses, models } = await this.be.harnesses();
      this.set({ harnesses, models });
    } catch (e: any) {
      this.toast("error", "Could not load harnesses", e?.message ?? String(e));
    }
  }

  /* ---------- sessions ---------- */
  async refreshTrash() {
    try {
      const { sessions } = await this.be.trash();
      this.set({ trash: sessions });
    } catch {
      /* older server without the trash route */
    }
  }
  async restoreSession(id: string) {
    try {
      await this.be.restoreSession(id);
      await Promise.all([this.refreshSessions(), this.refreshTrash()]);
      this.toast("ok", "Restored", "the chat is back with its full history");
    } catch (e: any) {
      this.toast("error", "Restore failed", e.message);
    }
  }
  async purgeSession(id: string) {
    try {
      await this.be.purgeSession(id);
      await this.refreshTrash();
    } catch (e: any) {
      this.toast("error", "Delete forever failed", e.message);
    }
  }

  async refreshSessions() {
    try {
      const { sessions } = await this.be.listSessions();
      const map: Record<string, SessionMeta> = {};
      const since = { ...this.state.stateSince };
      for (const s of sessions) {
        map[s.id] = s;
        const prev = this.state.sessions[s.id];
        if (!prev || prev.state !== s.state || !since[s.id]) since[s.id] = toMs(s.updated_at);
      }
      const views = { ...this.state.views };
      for (const id of Object.keys(views)) if (!map[id]) delete views[id];
      this.set({ sessions: map, order: sessions.map((s) => s.id), sessionsLoaded: true, sessionsError: undefined, stateSince: since, views });
    } catch (e: any) {
      this.set({ sessionsError: e.message ?? String(e), sessionsLoaded: true });
    }
  }
  refreshSessionsSoon() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => void this.refreshSessions(), 350);
  }

  async ensureHydrated(id: string) {
    const v = this.state.views[id];
    if (v && (v.hydration === "ready" || v.hydration === "loading")) return;
    this.buffers[id] = [];
    this.set((s) => ({ views: { ...s.views, [id]: { ...emptyView(), lastSeq: v?.lastSeq ?? 0 } } }));
    try {
      const { events } = await this.be.getEvents(id);
      let view = this.state.views[id] ?? emptyView();
      view = this.applyFrames(view, events, true);
      view = this.applyFrames(view, this.buffers[id] ?? [], false);
      delete this.buffers[id];
      this.set((s) => ({ views: { ...s.views, [id]: { ...view, hydration: "ready" } } }));
    } catch (e: any) {
      delete this.buffers[id];
      this.set((s) => ({
        views: { ...s.views, [id]: { ...(s.views[id] ?? emptyView()), hydration: "error", hydrationError: e.message ?? String(e) } },
      }));
    }
  }

  async rehydrate(id: string) {
    const v = this.state.views[id];
    if (!v || v.hydration !== "ready") return this.ensureHydrated(id);
    try {
      const { events } = await this.be.getEvents(id);
      const view = this.applyFrames(this.state.views[id], events, true);
      this.set((s) => ({ views: { ...s.views, [id]: view } }));
    } catch (e: any) {
      this.toast("error", "Rehydration failed", e.message);
    }
  }

  /** Apply frames with the seq-dedupe rule. `replay` frames never change session state. */
  private applyFrames(view: SessionView, frames: Frame[], replay: boolean): SessionView {
    let v = view;
    let clock = 0; // during replay, events without `at` inherit the last known timestamp
    for (const f of frames) {
      if ("at" in f.ev) clock = toMs((f.ev as any).at);
      if (f.seq <= v.lastSeq) continue;
      const t = replay ? clock || Date.now() : Date.now();
      v = reduce({ ...v, lastSeq: f.seq }, f.ev, t);
    }
    return v;
  }

  private onFrame(f: Frame) {
    const ev = f.ev;
    /* global channels: todos + feed upserts (not tied to a session view) */
    if (ev.type === "todo.upsert") {
      this.set((s) => ({ todos: { ...s.todos, [ev.todo.id]: ev.todo } }));
      return;
    }
    if (ev.type === "feed.upsert") {
      const isNew = !this.state.feed[ev.item.id];
      this.set((s) => ({ feed: { ...s.feed, [ev.item.id]: ev.item } }));
      if (isNew && ev.item.state === "unread" && ev.item.importance !== "low") {
        this.toast("info", ev.item.type === "permission" ? "Decision needed" : "Feed", ev.item.title);
      }
      return;
    }
    const id = ev.sessionId;
    /* deleted on any device → gone here too, instantly (row + cached view) */
    if (ev.type === "session.deleted") {
      this.refreshTrash();
      this.set((s) => {
        const sessions = { ...s.sessions };
        const views = { ...s.views };
        delete sessions[id];
        delete views[id];
        delete this.buffers[id];
        return { sessions, views, order: s.order.filter((x) => x !== id) };
      });
      return;
    }
    if (ev.type === "session.created" && !this.state.sessions[id]) this.refreshSessionsSoon();

    /* metadata changes (archive/retitle/regroup) patch the row in place */
    if (ev.type === "session.updated") {
      const meta = this.state.sessions[id];
      if (!meta) this.refreshSessionsSoon(); // a restore re-lists it here
      if (meta) {
        this.set((s) => ({
          sessions: {
            ...s.sessions,
            [id]: {
              ...meta,
              ...(ev.title !== undefined ? { title: ev.title } : {}),
              ...(ev.project !== undefined ? { project: ev.project ?? undefined } : {}),
              ...(ev.archived !== undefined ? { archived: ev.archived ? 1 : 0 } : {}),
              ...(ev.model !== undefined ? { model: ev.model ?? undefined } : {}),
              ...(ev.provider !== undefined ? { provider: ev.provider ?? undefined } : {}),
            },
          },
        }));
      }
      return;
    }

    // Live session.state is authoritative for the session row (replay never is).
    if (ev.type === "session.state") {
      const meta = this.state.sessions[id];
      if (meta) {
        this.set((s) => ({
          sessions: {
            ...s.sessions,
            [id]: { ...meta, state: ev.state, live: ev.state === "closed" ? false : ev.state === "error" ? meta.live : true, updated_at: Date.now() },
          },
          stateSince: { ...s.stateSince, [id]: Date.now() },
          order: [id, ...s.order.filter((x) => x !== id)],
        }));
      } else this.refreshSessionsSoon();
    }

    const v = this.state.views[id];
    if (!v || v.hydration === "error") {
      if (ev.type === "perm.request" || (ev.type === "session.state" && ev.state === "running")) void this.ensureHydrated(id);
      if (ev.type === "msg.done" && this.state.sessions[id]?.title === "new session") this.refreshSessionsSoon();
      return;
    }
    if (v.hydration === "loading") {
      (this.buffers[id] ??= []).push(f);
      return;
    }
    const next = this.applyFrames(v, [f], false);
    if (next !== v) this.set((s) => ({ views: { ...s.views, [id]: next } }));
    if (ev.type === "msg.done" && next.msgs[ev.messageId]?.role === "user") this.refreshSessionsSoon();
    if (ev.type === "perm.request" && document.hidden) {
      try {
        document.title = `⚠ permission · Truss`;
      } catch { /* noop */ }
    }
  }

  /* ---------- actions ---------- */
  async createSession(body: CreateSessionBody) {
    const { session } = await this.be.createSession(body);
    this.set((s) => ({
      sessions: { ...s.sessions, [session.id]: session },
      order: [session.id, ...s.order.filter((x) => x !== session.id)],
      stateSince: { ...s.stateSince, [session.id]: Date.now() },
    }));
    void this.ensureHydrated(session.id);
    return session;
  }
  async prompt(id: string, text: string) {
    await this.be.prompt(id, text);
  }
  async interrupt(id: string) {
    try {
      await this.be.interrupt(id);
    } catch (e: any) {
      this.toast("error", "Interrupt failed", e.message);
    }
  }
  async switchModel(id: string, model: string, provider?: string) {
    try {
      const { mode } = await this.be.setSessionModel(id, model, provider);
      if (mode !== "live") {
        this.toast(
          "info",
          mode === "restart" ? "Model switched" : "Model saved",
          mode === "restart" ? "harness restarted, history kept" : "applies when the session resumes",
        );
      }
    } catch (e: any) {
      this.toast("error", "Couldn't switch model", e.message);
      throw e;
    }
  }
  async answer(id: string, requestId: string, choice: string) {
    try {
      await this.be.permission(id, requestId, choice);
    } catch (e: any) {
      this.toast("error", "Permission answer rejected", e.message);
    }
  }
  async closeSession(id: string) {
    try {
      await this.be.deleteSession(id, false);
      await this.refreshSessions();
    } catch (e: any) {
      this.toast("error", "Couldn't close session", e.message);
    }
  }
    async archiveSession(id: string, archived = true) {
    const be = this.state.backend;
    if (!be) return;
    try {
      await be.archiveSession(id, archived);
      this.set((s) => ({ sessions: { ...s.sessions, [id]: { ...s.sessions[id], archived: archived ? 1 : 0 } } }));
    } catch (e: any) {
      this.toast("error", archived ? "Couldn't archive the session" : "Couldn't restore the session", e?.message ?? String(e));
    }
  }

  async archiveProject(project: string, archived = true) {
    const be = this.state.backend;
    if (!be) return;
    try {
      const r: any = await be.archiveProject(project, archived);
      await this.refreshSessions();
      this.toast("ok", archived ? "Project archived" : "Project restored", `${r?.sessions ?? "?"} session(s)`);
    } catch (e: any) {
      this.toast("error", "Couldn't change the project", e?.message ?? String(e));
    }
  }

  async deleteSession(id: string) {
    try {
      await this.be.deleteSession(id, true);
      this.set((s) => {
        const sessions = { ...s.sessions };
        const views = { ...s.views };
        delete sessions[id];
        delete views[id];
        return { sessions, views, order: s.order.filter((x) => x !== id) };
      });
      await this.refreshSessions();
    } catch (e: any) {
      this.toast("error", "Couldn't delete session", e.message);
    }
  }
  async refreshHosts() {
    if (!this.be) return;
    try {
      const { hosts } = await this.be.hosts();
      this.set({ hosts, hostsLoaded: true });
    } catch (e: any) {
      this.toast("error", "Couldn't load hosts", e?.message ?? String(e));
    }
  }

  async refreshTodos() {
    if (!this.be) return;
    try {
      const { todos } = await this.be.todos();
      const map: Record<string, TodoItem> = {};
      for (const t of todos) map[t.id] = t;
      this.set({ todos: map, todosLoaded: true });
    } catch (e: any) {
      this.toast("error", "Couldn't load todos", e?.message ?? String(e));
    }
  }

  async refreshFeed() {
    if (!this.be) return;
    try {
      const { items } = await this.be.feed();
      const map: Record<string, FeedItem> = {};
      for (const it of items) map[it.id] = it;
      this.set({ feed: map, feedLoaded: true });
    } catch (e: any) {
      this.toast("error", "Couldn't load the feed", e?.message ?? String(e));
    }
  }

  async refreshTerminals() {
    try {
      const { terminals } = await this.be.listTerminals();
      this.set({ terminals: Array.isArray(terminals) ? terminals : [] });
    } catch (e: any) {
      this.toast("error", "Couldn't list terminals", e.message);
    }
  }
  async createTerminal(body: { cwd?: string; title?: string }) {
    const { terminal } = await this.be.createTerminal(body);
    await this.refreshTerminals();
    return terminal;
  }
  async deleteTerminal(id: string) {
    try {
      await this.be.deleteTerminal(id);
    } catch (e: any) {
      if (e.status !== 404) this.toast("error", "Couldn't kill terminal", e.message);
    }
    this.set((s) => ({ terminals: s.terminals.filter((t) => t.id !== id) }));
  }
  focus(id: string | undefined) {
    if (this.state.focused !== id) this.set({ focused: id });
  }
  toast(kind: Toast["kind"], title: string, body?: string) {
    const t: Toast = { id: ++this.toastN, kind, title, body };
    this.set((s) => ({ toasts: [...s.toasts.slice(-4), t] }));
    setTimeout(() => this.dismiss(t.id), kind === "error" ? 9000 : 4500);
  }
  dismiss(id: number) {
    this.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  }
}

export const store = new Store();
(window as any).__truss = store;

export function useApp<T>(sel: (s: AppState) => T): T {
  const selRef = useRef(sel);
  selRef.current = sel;
  const get = useCallback(() => selRef.current(store.state), []);
  return useSyncExternalStore(store.subscribe, get, get);
}

export function useNow(ms = 1000, active = true) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, active]);
  return now;
}

export const capsOf = (s: AppState, harness: string) =>
  s.harnesses.find((h) => h.id === harness)?.capabilities;
