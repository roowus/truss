import type {
  AgentInfo,
  BrowseResp,
  CreateSessionBody,
  DeliveryOption,
  FeedItem,
  FileEntry,
  FileRead,
  Frame,
  GitBranch,
  GitStatus,
  HarnessesResp,
  HostInfo,
  PairRequestInfo,
  MonitorData,
  NetInfo,
  PromptAttachment,
  TailscalePeer,
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
  onTitle?: (title: string) => void;
  onError?: (msg: string) => void;
}

export interface TerminalConn {
  send(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

export interface Backend {
  mode: "live" | "demo";
  /** probe: ask the server to one-shot-probe lazy adapters whose catalog is
     empty (first boot, issue #101) — only the New Session dialog passes it.
     Probing rides a POST (JSON body → preflight → not cross-site
     triggerable), never a GET param. */
  harnesses(opts?: { probe?: boolean }): Promise<HarnessesResp>;
  agents(): Promise<{ agents: AgentInfo[] }>;
  listSessions(): Promise<{ sessions: SessionMeta[] }>;
  createSession(body: CreateSessionBody): Promise<{ session: SessionMeta }>;
  getSession(id: string): Promise<{ session: SessionMeta }>;
  /** switch a session's model: live where the harness supports it, else restart-with-history or stored for next resume */
  setSessionModel(id: string, model: string, provider?: string): Promise<{ mode: "live" | "restart" | "stored" }>;
  getEvents(id: string): Promise<{ events: Frame[] }>;
  prompt(id: string, text: string, attachments?: PromptAttachment[]): Promise<{ ok: boolean }>;
  /** upload a file into the session's workspace (.truss-uploads/) for attaching */
  upload(id: string, name: string, dataBase64: string): Promise<{ upload: PromptAttachment }>;
  interrupt(id: string): Promise<{ ok: boolean }>;
  permission(id: string, requestId: string, choice: string): Promise<{ ok: boolean }>;
  deleteSession(id: string, hard: boolean): Promise<unknown>;
  /** the 30-day trash: list / restore / delete-forever */
  trash(): Promise<{ sessions: SessionMeta[] }>;
  /** bulk trash move (issue #4): every id gets single-delete semantics */
  bulkDeleteSessions(ids: string[]): Promise<{ deleted: number }>;
  restoreSession(id: string): Promise<unknown>;
  purgeSession(id: string): Promise<unknown>;
  archiveSession(id: string, archived: boolean): Promise<unknown>;
  archiveProject(project: string, archived: boolean): Promise<unknown>;
  /** pin/unpin (issue #86): pinned rows float to the top of their sidebar section */
  pinSession(id: string, pinned: boolean): Promise<unknown>;
  /** retitle a chat (issue #141): the tab's double-click rename */
  renameSession(id: string, title: string): Promise<unknown>;
  /** GitHub-style labels (issue #174): replace-all set — the server cleans
      (trim/dedupe/cap) and returns the authoritative list */
  setSessionLabels(id: string, labels: string[]): Promise<{ id: string; labels: string[] }>;
  /** the label registry — every label in use, for the sidebar filter */
  listLabels(): Promise<{ labels: string[] }>;
  listTerminals(): Promise<{ terminals: TerminalInfo[] }>;
  createTerminal(body: { cwd?: string; title?: string }): Promise<{ terminal: TerminalInfo }>;
  deleteTerminal(id: string): Promise<unknown>;
  renameTerminal(id: string, title: string): Promise<unknown>;
  pinTerminal(id: string, pinned: boolean): Promise<unknown>;
  skills(cwd: string): Promise<{ skills: SkillInfo[] }>;
  /** Files panel: workspace browser, confined server-side to `root` */
  listFiles(root: string, path?: string, q?: string): Promise<{ entries: FileEntry[] }>;
  /** New Session cwd picker (issue #106): no path → the browse roots;
     with a path → that directory's subdirectories (names only) */
  browse(path?: string, showHidden?: boolean): Promise<BrowseResp>;
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
  /** Remote hosts registry */
  hosts(): Promise<{ hosts: HostInfo[]; pendingPair: PairRequestInfo[] }>;
  createHost(label: string, note?: string): Promise<{ host: HostInfo; token: string }>;
  rotateHostToken(id: string): Promise<{ token: string }>;
  revokeHost(id: string, revoked: boolean): Promise<unknown>;
  pinHost(id: string, pinned: boolean): Promise<unknown>;
  /** relabel a remote host (issue #147): display-only — the id is the identity and never changes */
  renameHost(id: string, label: string): Promise<unknown>;
  deleteHost(id: string): Promise<unknown>;
  /** auto-pairing (issue #111 review): the Allow/Deny click on a device that
     ran the installer and announced itself. The wizard passes its own
     hostId + in-memory token so the device pairs into the wizard's host and
     its waiting screen flips; the sidebar's standalone row approves bare
     (a fresh host is created). */
  approvePairRequest(id: string, into?: { hostId: string; token: string }): Promise<{ ok: boolean; hostId: string }>;
  denyPairRequest(id: string): Promise<{ ok: boolean }>;
  /** installer delivery (issue #1): short single-use pairing command, or
     taildrop the standalone script to the picked tailnet device.
     Last mile (issue #91): deliveryOptions orders the ways by what the user
     must type (tailscale-ssh = 0 leads when the peer allows); sshInstall is
     the zero-typing path — the server runs the installer on the peer. */
  pairHost(id: string, token: string, serverUrl: string): Promise<{ code: string; expiresAt: number; url: string; command: string }>;
  taildropHost(id: string, peer: string, token: string, serverUrl: string): Promise<{ ok: boolean; file: string; command: string; typedChars: number }>;
  deliveryOptions(id: string, peer: string | null, token: string, serverUrl: string): Promise<{ options: DeliveryOption[] }>;
  sshInstall(id: string, peer: string, token: string, serverUrl: string): Promise<{ ok: boolean }>;
  /** Monitor: local + remote host vitals */
  metrics(): Promise<MonitorData>;
  /** network reachability (tailscale detect, LAN addrs, serve toggle) */
  netInfo(): Promise<NetInfo>;
  tailscalePeers(): Promise<{ self?: TailscalePeer; peers: TailscalePeer[] }>;
  tailscaleServe(on: boolean): Promise<{ tailscale: NetInfo["tailscale"] }>;
  /** Tasks panel (kanban) */
  tasks(): Promise<{ tasks: TaskInfo[] }>;
  createTask(body: { title: string; prompt: string; cwd: string; harness: string; schedule?: string }): Promise<{ task: TaskInfo }>;
  updateTask(id: string, patch: Partial<Pick<TaskInfo, "title" | "prompt" | "status">> & { schedule?: string | null }): Promise<unknown>;
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
    harnesses: (opts) => (opts?.probe ? req("POST", "/api/harnesses/probe", {}) : req("GET", "/api/harnesses")),
    agents: () => req<{ agents: AgentInfo[] }>("GET", "/api/agents"),
    listSessions: () => req("GET", "/api/sessions"),
    createSession: (b) => req("POST", "/api/sessions", b),
    getSession: (id) => req("GET", `/api/sessions/${encodeURIComponent(id)}`),
    setSessionModel: (id, model, provider) =>
      req("POST", `/api/sessions/${encodeURIComponent(id)}/model`, { model, provider }),
    getEvents: (id) => req("GET", `/api/sessions/${encodeURIComponent(id)}/events`),
    prompt: (id, text, attachments) => req("POST", `/api/sessions/${encodeURIComponent(id)}/prompt`, { text, attachments }),
    upload: (id, name, dataBase64) => req("POST", `/api/sessions/${encodeURIComponent(id)}/upload`, { name, dataBase64 }),
    interrupt: (id) => req("POST", `/api/sessions/${encodeURIComponent(id)}/interrupt`, {}),
    permission: (id, requestId, choice) =>
      req("POST", `/api/sessions/${encodeURIComponent(id)}/permission`, { requestId, choice }),
    trash: () => req("GET", "/api/trash"),
    bulkDeleteSessions: (ids) => req("POST", "/api/sessions/bulk-delete", { ids }),
    restoreSession: (id) => req("POST", `/api/sessions/${encodeURIComponent(id)}/restore`, {}),
    purgeSession: (id) => req("POST", `/api/sessions/${encodeURIComponent(id)}/purge`, {}),
    deleteSession: (id, hard) =>
      req("DELETE", `/api/sessions/${encodeURIComponent(id)}${hard ? "?hard=1" : ""}`),
    archiveSession: (id, archived) =>
      req("POST", `/api/sessions/${encodeURIComponent(id)}/archive`, { archived }),
    archiveProject: (project, archived) =>
      req("POST", `/api/projects/archive`, { project, archived }),
    pinSession: (id, pinned) =>
      req("POST", `/api/sessions/${encodeURIComponent(id)}/pin`, { pinned }),
    renameSession: (id, title) =>
      req("POST", `/api/sessions/${encodeURIComponent(id)}/rename`, { title }),
    setSessionLabels: (id, labels) =>
      req("POST", `/api/sessions/${encodeURIComponent(id)}/labels`, { labels }),
    listLabels: () => req("GET", "/api/labels"),
    listTerminals: async () => {
      const r = await req<any>("GET", "/api/terminals");
      return { terminals: r.terminals ?? r ?? [] };
    },
    createTerminal: async (b) => {
      const r = await req<any>("POST", "/api/terminals", b);
      return { terminal: r.terminal ?? r };
    },
    deleteTerminal: (id) => req("DELETE", `/api/terminals/${encodeURIComponent(id)}`),
    renameTerminal: (id, title) => req("POST", `/api/terminals/${encodeURIComponent(id)}/rename`, { title }),
    pinTerminal: (id, pinned) => req("POST", `/api/terminals/${encodeURIComponent(id)}/pin`, { pinned }),
    skills: (cwd) => req("GET", `/api/skills?cwd=${encodeURIComponent(cwd)}`),
    listFiles: (root, path, q) =>
      req("GET", `/api/files?root=${encodeURIComponent(root)}${path ? `&path=${encodeURIComponent(path)}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}`),
    browse: (path, showHidden) =>
      req("GET", `/api/browse${path ? `?path=${encodeURIComponent(path)}${showHidden ? "&hidden=1" : ""}` : ""}`),
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
    hosts: () => req("GET", "/api/hosts"),
    createHost: (label, note) => req("POST", "/api/hosts", { label, note }),
    rotateHostToken: (id) => req("POST", `/api/hosts/${encodeURIComponent(id)}/token`, {}),
    revokeHost: (id, revoked) => req("POST", `/api/hosts/${encodeURIComponent(id)}/revoke`, { revoked }),
    pinHost: (id, pinned) => req("POST", `/api/hosts/${encodeURIComponent(id)}/pin`, { pinned }),
    renameHost: (id, label) => req("POST", `/api/hosts/${encodeURIComponent(id)}/rename`, { label }),
    deleteHost: (id) => req("DELETE", `/api/hosts/${encodeURIComponent(id)}`),
    approvePairRequest: (id, into) => req("POST", `/api/pair/request/${encodeURIComponent(id)}/approve`, into ?? {}),
    denyPairRequest: (id) => req("POST", `/api/pair/request/${encodeURIComponent(id)}/deny`, {}),
    pairHost: (id, token, serverUrl) => req("POST", `/api/hosts/${encodeURIComponent(id)}/pair`, { token, serverUrl }),
    taildropHost: (id, peer, token, serverUrl) => req("POST", `/api/hosts/${encodeURIComponent(id)}/taildrop`, { peer, token, serverUrl }),
    deliveryOptions: (id, peer, token, serverUrl) => req("POST", `/api/hosts/${encodeURIComponent(id)}/delivery`, { peer: peer ?? undefined, token, serverUrl }),
    sshInstall: (id, peer, token, serverUrl) => req("POST", `/api/hosts/${encodeURIComponent(id)}/ssh-install`, { peer, token, serverUrl }),
    metrics: () => req("GET", "/api/metrics"),
    netInfo: () => req("GET", "/api/net"),
    tailscalePeers: () => req("GET", "/api/net/tailscale/peers"),
    tailscaleServe: (on) => req("POST", "/api/net/tailscale-serve", { on }),
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
          else if (f.type === "title") h.onTitle?.(f.title);
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
