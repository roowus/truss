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
}

export interface SessionMeta {
  id: string;
  harness: HarnessId;
  title: string;
  cwd: string;
  model?: string;
  project?: string;
  state: SessionState;
  archived?: number;
  created_at: string | number;
  updated_at: string | number;
  live: boolean;
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
export type FeedType = "todo" | "permission" | "work_done" | "task_run" | "error" | "context" | "report" | "note";
export type FeedImportance = "low" | "normal" | "high" | "urgent";
export type FeedState = "unread" | "read" | "saved" | "dismissed" | "done";
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
}

type Base = { sessionId: string };
type At = string | number;

export type ProtoEvent =
  | (Base & { type: "session.created"; harness: HarnessId; title: string; cwd: string; model?: string; project?: string; at: At })
  | (Base & { type: "session.state"; state: SessionState; detail?: string })
  | (Base & { type: "session.updated"; title?: string; project?: string | null; archived?: boolean })
  | (Base & { type: "session.deleted" })
  | (Base & { type: "todo.upsert"; todo: TodoItem })
  | (Base & { type: "feed.upsert"; item: FeedItem })
  | (Base & { type: "msg.start"; messageId: string; role: "user" | "assistant" | "system"; at: At })
  | (Base & { type: "msg.chunk"; messageId: string; text: string; channel?: string })
  | (Base & { type: "msg.done"; messageId: string; stopReason?: string })
  | (Base & { type: "tool.call"; toolCallId: string; name: string; args: unknown; callId?: string })
  | (Base & { type: "tool.update"; toolCallId: string; output?: string })
  | (Base & { type: "tool.done"; toolCallId: string; ok: boolean; durationMs?: number; output?: string })
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
    })
  | (Base & { type: "subagent.spawn"; agentId: string; label: string; parentAgentId?: string })
  | (Base & { type: "subagent.done"; agentId: string; ok: boolean })
  | (Base & { type: "ctx.usage"; used: number; total: number; by?: Record<string, number> });

export interface Frame {
  seq: number;
  ev: ProtoEvent;
}

export type EvOf<T extends ProtoEvent["type"]> = Extract<ProtoEvent, { type: T }>;
