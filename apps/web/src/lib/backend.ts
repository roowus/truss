import type {
  AgentInfo,
  CreateSessionBody,
  Frame,
  HarnessesResp,
  SessionMeta,
  SkillInfo,
  TerminalInfo,
} from "./proto";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type ConnStatus =
  | { kind: "connecting"; attempt: number }
  | { kind: "open"; since: number }
  | { kind: "closed"; retryAt: number; attempt: number };

export interface TerminalHandlers {
  onHello?: (h: { title?: string; alive: boolean }) => void;
  onOut: (data: string) => void;
  onExit?: (code: number) => void;
  onError?: (msg: string) => void;
}

export interface TerminalConn {
  send(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

export interface Backend {
  mode: "live" | "demo";
  harnesses(): Promise<HarnessesResp>;
  agents(): Promise<{ agents: AgentInfo[] }>;
  listSessions(): Promise<{ sessions: SessionMeta[] }>;
  createSession(body: CreateSessionBody): Promise<{ session: SessionMeta }>;
  getSession(id: string): Promise<{ session: SessionMeta }>;
  getEvents(id: string): Promise<{ events: Frame[] }>;
  prompt(id: string, text: string): Promise<{ ok: boolean }>;
  interrupt(id: string): Promise<{ ok: boolean }>;
  permission(id: string, requestId: string, choice: string): Promise<{ ok: boolean }>;
  deleteSession(id: string, hard: boolean): Promise<unknown>;
  archiveSession(id: string, archived: boolean): Promise<unknown>;
  archiveProject(project: string, archived: boolean): Promise<unknown>;
  listTerminals(): Promise<{ terminals: TerminalInfo[] }>;
  createTerminal(body: { cwd?: string; title?: string }): Promise<{ terminal: TerminalInfo }>;
  deleteTerminal(id: string): Promise<unknown>;
  skills(cwd: string): Promise<{ skills: SkillInfo[] }>;
  getLayout(): Promise<{ layout: string | null }>;
  /** server-aggregated cost + token ledger across all sessions */
  costs(): Promise<any>;
  credentials(): Promise<any>;
  upsertCredential(route: any): Promise<any>;
  deleteCredential(port: number): Promise<any>;
  credentialsService(action: string): Promise<any>;
  router(): Promise<any>;
  routerService(action: string): Promise<any>;
  putLayout(layout: string): Promise<unknown>;
  connectEvents(onFrame: (f: Frame) => void, onStatus: (s: ConnStatus) => void): () => void;
  connectTerminal(id: string, h: TerminalHandlers): TerminalConn;
  /** demo-only hook: kill every harness process and bounce the bus */
  simulateRestart?: () => void;
}

/* ------------------------------------------------------------------ */
/* Live backend — same-origin REST + WS                                */
/* ------------------------------------------------------------------ */

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ApiError(0, `Network error reaching ${url} — is the Truss server up?`);
  }
  const text = await res.text();
  let data: any = undefined;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    /* non-json */
  }
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || text.slice(0, 200) || res.statusText;
    throw new ApiError(res.status, `${method} ${url} → ${res.status}: ${msg}`);
  }
  if (data === undefined) throw new ApiError(res.status, `${method} ${url} returned non-JSON`);
  return data as T;
}

const wsUrl = (path: string) =>
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`;

export function createLiveBackend(): Backend {
  return {
    mode: "live",
    harnesses: () => req("GET", "/api/harnesses"),
    agents: () => req<{ agents: AgentInfo[] }>("GET", "/api/agents"),
    listSessions: () => req("GET", "/api/sessions"),
    createSession: (b) => req("POST", "/api/sessions", b),
    getSession: (id) => req("GET", `/api/sessions/${encodeURIComponent(id)}`),
    getEvents: (id) => req("GET", `/api/sessions/${encodeURIComponent(id)}/events`),
    prompt: (id, text) => req("POST", `/api/sessions/${encodeURIComponent(id)}/prompt`, { text }),
    interrupt: (id) => req("POST", `/api/sessions/${encodeURIComponent(id)}/interrupt`, {}),
    permission: (id, requestId, choice) =>
      req("POST", `/api/sessions/${encodeURIComponent(id)}/permission`, { requestId, choice }),
    deleteSession: (id, hard) =>
      req("DELETE", `/api/sessions/${encodeURIComponent(id)}${hard ? "?hard=1" : ""}`),
    archiveSession: (id, archived) =>
      req("POST", `/api/sessions/${encodeURIComponent(id)}/archive`, { archived }),
    archiveProject: (project, archived) =>
      req("POST", `/api/projects/archive`, { project, archived }),
    listTerminals: async () => {
      const r = await req<any>("GET", "/api/terminals");
      return { terminals: r.terminals ?? r ?? [] };
    },
    createTerminal: async (b) => {
      const r = await req<any>("POST", "/api/terminals", b);
      return { terminal: r.terminal ?? r };
    },
    deleteTerminal: (id) => req("DELETE", `/api/terminals/${encodeURIComponent(id)}`),
    skills: (cwd) => req("GET", `/api/skills?cwd=${encodeURIComponent(cwd)}`),
    getLayout: async () => {
      const r = await req<any>("GET", "/api/layout");
      return { layout: r?.layout ?? null };
    },
    costs: () => req("GET", "/api/costs"),
    credentials: () => req("GET", "/api/credentials"),
    upsertCredential: (route) => req("POST", "/api/credentials", route),
    deleteCredential: (port) => req("DELETE", `/api/credentials/${port}`),
    credentialsService: (action) => req("POST", "/api/credentials/service", { action }),
    router: () => req("GET", "/api/router"),
    routerService: (action) => req("POST", "/api/router/service", { action }),
    putLayout: (layout) => req("PUT", "/api/layout", { layout }),

    connectEvents(onFrame, onStatus) {
      let ws: WebSocket | null = null;
      let attempt = 0;
      let timer: number | undefined;
      let disposed = false;
      const open = () => {
        if (disposed) return;
        onStatus({ kind: "connecting", attempt });
        ws = new WebSocket(wsUrl("/events"));
        ws.onopen = () => {
          attempt = 0;
          onStatus({ kind: "open", since: Date.now() });
        };
        ws.onmessage = (m) => {
          try {
            const f = JSON.parse(m.data as string) as Frame;
            if (f && typeof f.seq === "number" && f.ev) onFrame(f);
          } catch {
            /* ignore malformed frame */
          }
        };
        ws.onclose = () => {
          if (disposed) return;
          attempt++;
          const delay = Math.min(10_000, 400 * 2 ** Math.min(attempt, 5)) + Math.random() * 300;
          onStatus({ kind: "closed", retryAt: Date.now() + delay, attempt });
          timer = window.setTimeout(open, delay);
        };
        ws.onerror = () => ws?.close();
      };
      open();
      return () => {
        disposed = true;
        clearTimeout(timer);
        ws?.close();
      };
    },

    connectTerminal(id, h) {
      const ws = new WebSocket(wsUrl(`/api/terminal/${encodeURIComponent(id)}/ws`));
      const queue: string[] = [];
      const send = (o: unknown) => {
        const s = JSON.stringify(o);
        if (ws.readyState === WebSocket.OPEN) ws.send(s);
        else queue.push(s);
      };
      ws.onopen = () => queue.splice(0).forEach((s) => ws.send(s));
      ws.onmessage = (m) => {
        try {
          const f = JSON.parse(m.data as string);
          if (f.type === "hello") h.onHello?.({ title: f.title, alive: !!f.alive });
          else if (f.type === "out") h.onOut(f.data);
          else if (f.type === "exit") h.onExit?.(f.code);
        } catch {
          /* ignore */
        }
      };
      ws.onerror = () => h.onError?.("terminal socket error");
      return {
        send: (data) => send({ type: "in", data }),
        resize: (cols, rows) => send({ type: "resize", cols, rows }),
        close: () => ws.close(),
      };
    },
  };
}

/** Probe for a real Truss server; fall back to the in-browser demo. */
export async function detectBackend(): Promise<Backend> {
  const params = new URLSearchParams(location.search);
  if (params.has("demo")) return (await import("./demo")).createDemoBackend();
  if (params.has("live")) return createLiveBackend();
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2500);
    const r = await fetch("/health", { signal: ctl.signal });
    clearTimeout(t);
    const j = await r.json();
    if (j && j.ok) return createLiveBackend();
  } catch {
    /* fall through */
  }
  return (await import("./demo")).createDemoBackend();
}
