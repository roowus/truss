import type {
  AgentInfo,
  CreateSessionBody,
  FeedItem,
  FileEntry,
  FileRead,
  Frame,
  GitBranch,
  GitStatus,
  HarnessesResp,
  SessionMeta,
  SkillInfo,
  TaskInfo,
  TodoItem,
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
  /** Files panel: workspace browser, confined server-side to `root` */
  listFiles(root: string, path?: string, q?: string): Promise<{ entries: FileEntry[] }>;
  readFile(root: string, path: string): Promise<FileRead>;
  writeFile(root: string, path: string, content: string): Promise<FileRead>;
  createFile(root: string, path: string, kind: "file" | "dir"): Promise<FileEntry>;
  /** Skills panel switches (live-only; demo returns ok) */
  toggleSkill(source: string, disabled: boolean): Promise<unknown>;
  createSkill(cwd: string, name: string, description: string): Promise<unknown>;
  deleteSkill(source: string): Promise<unknown>;
  /** Git panel (read-mostly; switch is the only mutation) */
  gitStatus(cwd: string): Promise<GitStatus>;
  gitBranches(cwd: string): Promise<{ branches: GitBranch[] }>;
  gitGraph(cwd: string, n?: number): Promise<{ graph: string }>;
  gitDiff(cwd: string, path: string, staged: boolean): Promise<{ diff: string }>;
  gitSwitch(cwd: string, branch: string, create: boolean): Promise<{ branch: string }>;
  /** Tasks panel (kanban) */
  tasks(): Promise<{ tasks: TaskInfo[] }>;
  createTask(body: { title: string; prompt: string; cwd: string; harness: string }): Promise<{ task: TaskInfo }>;
  updateTask(id: string, patch: Partial<Pick<TaskInfo, "title" | "prompt" | "status">>): Promise<unknown>;
  deleteTask(id: string): Promise<unknown>;
  runTask(id: string): Promise<{ session: SessionMeta }>;
  /** Todos (user-facing tasks filed by agents) */
  todos(): Promise<{ todos: TodoItem[] }>;
  createTodo(body: { title: string; notes?: string; priority?: string; deadline?: number | null; estimate?: string | null; labels?: string[] }): Promise<{ todo: TodoItem }>;
  updateTodo(id: string, patch: Record<string, unknown>): Promise<{ todo: TodoItem }>;
  resolveTodoAccess(id: string, requesterId: string, approve: boolean): Promise<{ todo: TodoItem }>;
  /** Feed (the inbox) */
  feed(state?: string): Promise<{ items: FeedItem[] }>;
  setFeedState(id: string, state: string): Promise<{ item: FeedItem }>;
  shareFeed(id: string, sessionId: string): Promise<{ item: FeedItem }>;
  /** Practices (TRUSS.md) */
  practices(): Promise<{ text: string; path: string }>;
  savePractices(text: string): Promise<unknown>;
  composePractices(cwd: string, project?: string): Promise<{ layers: { path: string; scope: string; text: string }[]; composed: string }>;
  getLayout(): Promise<{ layout: string | null }>;
  /** server-aggregated cost + token ledger across all sessions */
  costs(): Promise<any>;
  /** per-day token/cost buckets (heat grid + trend) */
  costsDaily(): Promise<{ days: { day: string; calls: number; tokensIn: number; tokensOut: number; costUsd: number | null }[] }>;
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
    listFiles: (root, path, q) =>
      req("GET", `/api/files?root=${encodeURIComponent(root)}${path ? `&path=${encodeURIComponent(path)}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}`),
    readFile: (root, path) => req("GET", `/api/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`),
    writeFile: (root, path, content) => req("PUT", "/api/file", { root, path, content }),
    createFile: (root, path, kind) => req("POST", "/api/files/create", { root, path, kind }),
    toggleSkill: (source, disabled) => req("POST", "/api/skills/toggle", { source, disabled }),
    createSkill: (cwd, name, description) => req("POST", "/api/skills/create", { cwd, name, description }),
    deleteSkill: (source) => req("POST", "/api/skills/delete", { source }),
    gitStatus: (cwd) => req("GET", `/api/git/status?cwd=${encodeURIComponent(cwd)}`),
    gitBranches: (cwd) => req("GET", `/api/git/branches?cwd=${encodeURIComponent(cwd)}`),
    gitGraph: (cwd, n) => req("GET", `/api/git/graph?cwd=${encodeURIComponent(cwd)}${n ? `&n=${n}` : ""}`),
    gitDiff: (cwd, path, staged) => req("GET", `/api/git/diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}${staged ? "&staged=1" : ""}`),
    gitSwitch: (cwd, branch, create) => req("POST", "/api/git/switch", { cwd, branch, create }),
    tasks: () => req("GET", "/api/tasks"),
    createTask: (b) => req("POST", "/api/tasks", b),
    updateTask: (id, patch) => req("PATCH", `/api/tasks/${encodeURIComponent(id)}`, patch),
    deleteTask: (id) => req("DELETE", `/api/tasks/${encodeURIComponent(id)}`),
    runTask: (id) => req("POST", `/api/tasks/${encodeURIComponent(id)}/run`, {}),
    todos: () => req("GET", "/api/todos"),
    createTodo: (b) => req("POST", "/api/todos", b),
    updateTodo: (id, patch) => req("PATCH", `/api/todos/${encodeURIComponent(id)}`, patch),
    resolveTodoAccess: (id, requesterId, approve) => req("POST", `/api/todos/${encodeURIComponent(id)}/access`, { requesterId, approve }),
    feed: (state) => req("GET", `/api/feed${state ? `?state=${encodeURIComponent(state)}` : ""}`),
    setFeedState: (id, state) => req("POST", `/api/feed/${encodeURIComponent(id)}/state`, { state }),
    shareFeed: (id, sessionId) => req("POST", `/api/feed/${encodeURIComponent(id)}/share`, { sessionId }),
    practices: () => req("GET", "/api/practices"),
    savePractices: (text) => req("PUT", "/api/practices", { text }),
    composePractices: (cwd, project) => req("GET", `/api/practices/compose?cwd=${encodeURIComponent(cwd)}${project ? `&project=${encodeURIComponent(project)}` : ""}`),
    getLayout: async () => {
      const r = await req<any>("GET", "/api/layout");
      return { layout: r?.layout ?? null };
    },
    costs: () => req("GET", "/api/costs"),
    costsDaily: () => req("GET", "/api/costs/daily"),
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
      let lastMsg = Date.now();
      /* zombie-socket watchdog: a sleeping lid or a dead tailnet hop can leave
         a socket looking open forever. The server pings every 15s; if nothing
         has arrived for 45s the socket is dead in practice — closing it runs
         the normal reconnect path, whose reopen triggers a full resync. */
      const watchdog = window.setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN && Date.now() - lastMsg > 45_000) ws.close();
      }, 10_000);
      /* waking the device: if the channel went quiet while hidden, force the
         reconnect now instead of waiting for the watchdog */
      const onVisible = () => {
        if (document.visibilityState === "visible" && ws && ws.readyState === WebSocket.OPEN && Date.now() - lastMsg > 30_000) ws.close();
      };
      document.addEventListener("visibilitychange", onVisible);
      const open = () => {
        if (disposed) return;
        onStatus({ kind: "connecting", attempt });
        ws = new WebSocket(wsUrl("/events"));
        ws.onopen = () => {
          attempt = 0;
          lastMsg = Date.now();
          onStatus({ kind: "open", since: Date.now() });
        };
        ws.onmessage = (m) => {
          lastMsg = Date.now();
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
        clearInterval(watchdog);
        document.removeEventListener("visibilitychange", onVisible);
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
