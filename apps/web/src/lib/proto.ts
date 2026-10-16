// Mirror of packages/proto — the non-negotiable event contract.

export type HarnessId = string; // pi | dsh | claude-code | hermes | <adapter>@<host>
export type SessionState = "spawning" | "idle" | "running" | "error" | "closed";

export interface Capabilities {
  permissions: boolean;
  subagents: boolean;
  streaming: boolean;
  queueWhileRunning: boolean;
}

export interface HarnessInfo {
  id: HarnessId;
  capabilities: Capabilities;
  /** the adapter can fill an empty model catalog on request (lazy ACP
      discovery: hermes, dsh) — the web app probes only these (at page boot;
      the New Session dialog re-asks once per open as a fallback) */
  probeable?: boolean;
}

export interface ModelInfo {
  harness: HarnessId;
  provider: string;
  model: string;
  label: string;
}

export interface HarnessesResp {
  harnesses: HarnessInfo[];
  models: ModelInfo[];
}

export interface AgentInfo {
  hostId: string;
  hostname: string;
  adapters: string[];
  /** version handshake (issue #100): protocol level + the agent's bundle
     hash; bundleCurrent compares it against the server's current build
     (undefined when either side predates the handshake) */
  protocol?: number;
  bundleHash?: string;
  bundleCurrent?: boolean;
  /** directory discovery (issue #123): the remote's home + its one suggested
     cwd, announced at hello. Absent on pre-discovery agents. */
  home?: string;
  suggestedCwd?: string;
}

export interface SessionMeta {
  id: string;
  harness: HarnessId;
  title: string;
  cwd: string;
  model?: string;
  provider?: string;
  project?: string;
  state: SessionState;
  archived?: number;
  /** pinned chats float to the top of their sidebar section (issue #86) */
  pinned?: boolean;
  /** set while the session sits in the 30-day trash (raw rows from /api/trash) */
  deleted_at?: string | number | null;
  created_at: string | number;
  updated_at: string | number;
  live: boolean;
  /** the harness's own session id (pi sessionId, dsh uuid) — the resume
     target for the harness's own CLI (issue #131) */
  harness_ref?: string | null;
}

export interface CreateSessionBody {
  harness: HarnessId;
  cwd: string;
  model?: string;
  provider?: string;
  title?: string;
  project?: string;
}

export interface TerminalInfo {
  id: string;
  title?: string;
  cwd?: string;
  alive?: boolean;
  /** in-memory pin (issue #86) — dies with the shell, like the shell */
  pinned?: boolean;
}

export interface SkillInfo {
  name: string;
  description: string;
  source: string;
  scope: string;
  /** Agent-Skills `disable-model-invocation` frontmatter flag ( Skills panel switch) */
  disabled?: boolean;
}

/* ── Files panel (workspace browser, confined server-side to a root) ── */
export interface FileEntry {
  name: string;
  path: string; // relative to the root
  kind: "dir" | "file";
  size: number;
  mtime: number;
}

export interface FileRead {
  name: string;
  path: string;
  size: number;
  mtime: number;
  kind: "text" | "image" | "binary";
  text?: string;
  truncated?: boolean;
  dataUrl?: string;
}

/* ── directory browsing (New Session cwd picker, issue #106): directory
     names only, confined to the server's browse roots ── */
export interface BrowseDir {
  name: string;
  path: string; // absolute
}
/** `roots` when no path was asked for; `dirs` + `parent` for a listing. */
export interface BrowseResp {
  roots?: string[];
  dirs?: BrowseDir[];
  parent?: string | null;
}

/* ── todos + feed ── */
export type TodoPriority = "low" | "normal" | "high" | "urgent";
export type TodoStatus = "open" | "done" | "dropped";
export interface TodoSubtask { id: string; text: string; done: boolean }
export interface TodoItem {
  id: string;
  sessionId?: string;
  title: string;
  notes: string;
  priority: TodoPriority;
  deadline?: number;
  estimate?: string;
  labels: string[];
  subtasks: TodoSubtask[];
  meta: Record<string, unknown>;
  status: TodoStatus;
  doneAt?: number;
  createdBy: "user" | "agent";
  sharedEditors: string[];
  deniedEditors: string[];
  createdAt: number;
  updatedAt: number;
}
export type FeedType = "todo" | "permission" | "work_done" | "task_run" | "error" | "context" | "report" | "note" | "doubletake";
export type FeedImportance = "low" | "normal" | "high" | "urgent";
export type FeedState = "unread" | "read" | "saved" | "dismissed" | "done";
export interface PromptAttachment {
  name: string;
  path: string;
  size: number;
  mime?: string;
}

export interface FeedItem {
  id: string;
  type: FeedType;
  sessionId?: string;
  title: string;
  body: string;
  importance: FeedImportance;
  data: Record<string, unknown>;
  state: FeedState;
  sharedWith: string[];
  createdAt: number;
  updatedAt: number;
}

/* ── Monitor (host vitals; shape mirrors packages/proto/src/metrics.ts) ── */
export interface HostMetrics {
  at: number;
  host: { hostname: string; os: string; kernel: string; arch: string; cpuModel: string; cores: number; freqMhz?: number; bootAt?: number };
  uptimeSec: number;
  cpu: {
    usage: number;
    perCore: number[];
    load: [number, number, number];
    procs: number;
    threads: number;
    running: number;
    blocked: number;
    /* optional below: additive protocol (issue #168) — older agents omit */
    zombies?: number;
    ctxtPerSec?: number;
    intrPerSec?: number;
    forksPerSec?: number;
    times?: { user: number; system: number; iowait: number; irq: number; softirq: number; steal: number };
  };
  pressure: { cpu: number; io: number; mem: number };
  mem: {
    total: number;
    used: number;
    available: number;
    cached: number;
    swapTotal: number;
    swapUsed: number;
    free?: number;
    buffers?: number;
    shared?: number;
    slab?: number;
    dirty?: number;
    writeback?: number;
    committed?: number;
    commitLimit?: number;
    hugeTotal?: number;
    hugeFree?: number;
    pageInKbs?: number;
    pageOutKbs?: number;
    swapInKbs?: number;
    swapOutKbs?: number;
    majFaultsPerSec?: number;
    oomKills?: number;
  };
  disks: { device: string; mount: string; fs: string; total: number; used: number; pct: number; inodePct?: number }[];
  diskIo?: { device: string; readBps: number; writeBps: number; rIops?: number; wIops?: number; inFlight?: number }[];
  net: {
    iface: string;
    rxBps: number;
    txBps: number;
    rxPps?: number;
    txPps?: number;
    rxTotal?: number;
    txTotal?: number;
    ip4?: string;
    ip6?: string[];
    mac?: string;
    mtu?: number;
    state?: string;
    speedMbps?: number;
  }[];
  sock?: { tcp: number; tcpTw: number; established: number; listen: number; closeWait: number; otherTcp: number; udp: number; raw: number; used: number };
  services?: { name: string; cpu: number; rssMb: number }[];
  logs?: { failedUnits: string[]; coredumps: number | null; lines: string[] | null };
  sys?: {
    users: string[];
    updatesPending: number | null;
    virt?: string;
    tz?: string;
    entropy?: number;
    filesUsed?: number;
    filesMax?: number;
    rebootRequired?: boolean;
    gateway?: { ip: string; iface: string };
  };
  temps: { label: string; c: number }[];
  fans?: { label: string; rpm: number }[];
  procs: { pid: number; cmd: string; cpu: number; rssMb: number; state: string; user?: string; memPct?: number; threads?: number; ageSec?: number }[];
}
export interface HistPoint { t: number; cpu: number; mem: number; rx: number; tx: number }
export interface MonitorEntry { hostname: string; metrics: HostMetrics; history: HistPoint[] }
export interface MonitorData { local: MonitorEntry; agents: Record<string, MonitorEntry | null> }

/* ── remote hosts (registered registry + live agent join) ── */
export interface HostInfo {
  id: string;
  label: string;
  tokenPrefix: string;
  createdAt: number;
  lastSeen?: number;
  revoked: boolean;
  /** pinned hosts float to the top of the sidebar's hosts section (issue #86) */
  pinned?: boolean;
  note: string;
  online: boolean;
  agent?: AgentInfo;
}
/** auto-pairing (issue #111 review): a device that ran the installer and is
   waiting for the UI's Allow click. Self-reported metadata only. */
export interface PairRequestInfo {
  id: string;
  hostname: string;
  os: string;
  tailscaleIp?: string;
  /** the requester's real source address — the only non-self-reported field */
  sourceIp: string;
  expiresAt: number;
}
export interface TailscalePeer {
  hostName: string;
  dnsName: string;
  ip4?: string;
  os?: string;
  online: boolean;
  lastSeen?: string;
  exitNode: boolean;
  exitNodeOption: boolean;
  tagged: boolean;
}

export interface NetInfo {
  port: number;
  /** the server's bind address (issue #33): the wizard's reachability filter reads this */
  bind?: string;
  /** operator-declared front door (TRUSS_PUBLIC_URL) — a proxy/DNS name that forwards to the server (audit B2) */
  publicUrl?: string;
  tailscale: {
    installed: boolean;
    ip4?: string;
    dnsName?: string;
    serveOn?: boolean;
    serveUrl?: string;
    canServe?: boolean;
    /** what the serve toggle will do if clicked now (issue #171) — while serve
       is off and clickable; show servePlan.warning BEFORE the click */
    servePlan?: { httpsPort: number; warning: string | null };
  };
  lan: string[];
}

/** installer last mile (issue #91): one way to get the agent onto the
   remote, ordered by what the user must type there (ssh = 0 leads).
   "interactive" (issue #111) is the pairing variant whose script prompts
   for the code instead of embedding it in the command. */
export interface DeliveryOption {
  kind: "ssh" | "taildrop" | "interactive" | "pairing";
  label: string;
  command: string;
  typedChars: number;
}

/* ── Git panel ── */
export interface GitChange {
  path: string;
  orig?: string;
  x: string; // staged letter
  y: string; // unstaged letter
}
export interface GitStatus {
  isRepo: boolean;
  branch?: string;
  ahead?: number;
  behind?: number;
  changes: GitChange[];
}
export interface GitBranch {
  name: string;
  current: boolean;
  last: string;
  at: number;
}

/* ── Tasks panel ── */
export type TaskStatus = "todo" | "doing" | "done" | "archived";
export interface TaskInfo {
  id: string;
  title: string;
  prompt: string;
  cwd: string;
  harness: string;
  status: TaskStatus;
  sessionId?: string;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  /* cron schedule (issue #16): the 5-field expr + the server's computed next
     slot, both in SERVER-local wall-clock semantics */
  schedule?: string;
  nextRunAt?: number;
}

type Base = { sessionId: string };
type At = string | number;

export type ProtoEvent =
  | (Base & { type: "session.created"; harness: HarnessId; title: string; cwd: string; model?: string; project?: string; at: At })
  | (Base & { type: "session.state"; state: SessionState; detail?: string })
  | (Base & { type: "session.updated"; title?: string; project?: string | null; archived?: boolean; pinned?: boolean; model?: string | null; provider?: string | null })
  | (Base & { type: "session.deleted" })
  | (Base & { type: "todo.upsert"; todo: TodoItem })
  | (Base & { type: "feed.upsert"; item: FeedItem })
  /* the remote-host registry flipped (agent hello/bye) — refetch hosts +
     harnesses (issue #100 manual test) */
  | (Base & { type: "agents.changed" })
  /* a device asked to auto-pair, or its request was decided (issue #111
     review) — refetch hosts (the pendingPair list) and toast the ask */
  | (Base & { type: "pair.changed"; event: "requested" | "resolved"; request?: PairRequestInfo })
  | (Base & { type: "models.updated"; harness: HarnessId })
  | (Base & { type: "msg.start"; messageId: string; role: "user" | "assistant" | "system"; at: At; attachments?: PromptAttachment[] })
  /* the server sink stamps `at` on every event that lacks one (issue #142
     audit) — optional here only because older payloads and imports predate it */
  | (Base & { type: "msg.chunk"; messageId: string; text: string; channel?: string; at?: At })
  | (Base & { type: "msg.done"; messageId: string; stopReason?: string; at?: At })
  | (Base & { type: "tool.call"; toolCallId: string; name: string; args: unknown; callId?: string; at?: At })
  | (Base & { type: "tool.update"; toolCallId: string; output?: string; at?: At })
  | (Base & { type: "tool.done"; toolCallId: string; ok: boolean; durationMs?: number; output?: string; at?: At })
  | (Base & { type: "perm.request"; requestId: string; tool: string; reason: string; options: string[] })
  | (Base & { type: "perm.resolve"; requestId: string; choice: string })
  | (Base & { type: "llm.call.start"; callId: string; model: string; at: At })
  | (Base & {
      type: "llm.call.done";
      callId: string;
      status: number;
      latencyMs: number;
      tokensIn?: number;
      tokensOut?: number;
      costUsd?: number;
      cacheRead?: number;
      cacheWrite?: number;
      retryOf?: string;
      at?: At;
    })
  | (Base & { type: "subagent.spawn"; agentId: string; label: string; parentAgentId?: string })
  | (Base & { type: "subagent.done"; agentId: string; ok: boolean })
  | (Base & { type: "ctx.usage"; used: number; total: number; by?: Record<string, number> });

export interface Frame {
  seq: number;
  ev: ProtoEvent;
}

export type EvOf<T extends ProtoEvent["type"]> = Extract<ProtoEvent, { type: T }>;
