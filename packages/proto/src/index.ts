/**
 * Truss internal event schema.
 * ACP-aligned at the harness boundary; extended with per-LLM-call
 * step events for the trajectory view.
 *
 * M1 revision: messages carry stable ids so chunks group into bubbles,
 * and sessions have lifecycle events so clients can track list changes.
 */

export type HarnessId = "pi" | "hermes" | "claude-code" | "dsh" | (string & {});

export interface SessionRef {
  sessionId: string;
  harness: HarnessId;
  cwd: string;
  model?: string;
}

/* ── session lifecycle ── */
export type SessionState = "spawning" | "idle" | "running" | "error" | "closed";

export interface SessionCreated {
  type: "session.created";
  sessionId: string;
  harness: HarnessId;
  title: string;
  cwd: string;
  model?: string;
  project?: string;
  at: number;
}
export interface SessionStateEvent {
  type: "session.state";
  sessionId: string;
  state: SessionState;
  detail?: string;
}
/** metadata changed (archive, retitle, regroup, model switch) without a lifecycle change */
export interface SessionUpdated {
  type: "session.updated";
  sessionId: string;
  title?: string;
  project?: string | null;
  archived?: boolean;
  model?: string | null;
  provider?: string | null;
  /** reasoning effort change (issue #27) */
  effort?: string | null;
}

/** hard-deleted: the row and its event log are gone. Broadcast-only (the FK
    cascade removes its events, so it cannot be replayed from the log) —
    clients that miss it catch up via the reconnect resync's session refetch. */
export interface SessionDeleted {
  type: "session.deleted";
  sessionId: string;
}

/* ── todos + feed (user-facing work filed by agents; the inbox) ── */

export type TodoPriority = "low" | "normal" | "high" | "urgent";
export type TodoStatus = "open" | "done" | "dropped";
export interface TodoSubtask { id: string; text: string; done: boolean }
export interface TodoItem {
  id: string;
  /** owning session; null when created by the user or the session is gone */
  sessionId?: string;
  title: string;
  notes: string;
  priority: TodoPriority;
  deadline?: number; // epoch ms
  estimate?: string; // agent's effort guess ("S"/"M"/"L"/"20m" — free-form)
  labels: string[];
  subtasks: TodoSubtask[];
  meta: Record<string, unknown>; // free-form agent-chosen fields
  status: TodoStatus;
  doneAt?: number;
  createdBy: "user" | "agent";
  sharedEditors: string[];
  /** view-share roster (issue #26) — distinct from edit sharing */
  sharedWith: string[]; // sessionIds approved via todo-access cards
  deniedEditors: string[]; // sessionIds denied (their edits are refused quietly)
  createdAt: number;
  updatedAt: number;
}

export type FeedType = "todo" | "permission" | "work_done" | "task_run" | "error" | "context" | "report" | "note";
export type FeedImportance = "low" | "normal" | "high" | "urgent";
export type FeedState = "unread" | "read" | "saved" | "dismissed" | "done";
export interface FeedItem {
  id: string;
  type: FeedType;
  sessionId?: string; // source session
  title: string;
  body: string; // markdown
  importance: FeedImportance;
  data: Record<string, unknown>; // per-type payload (perm requestId/options, todo id, …)
  state: FeedState;
  sharedWith: string[];
  /** idempotency key — same key updates instead of duplicating */
  dedupeKey?: string; // sessionIds that may read it via MCP
  createdAt: number;
  updatedAt: number;
}

/* broadcast-only (feed/todos persist in their own tables; replay = REST) */
export interface TodoUpsert {
  type: "todo.upsert";
  sessionId: string; // owner session or "" — carried for the frame shape only
  todo: TodoItem;
}
export interface FeedUpsert {
  type: "feed.upsert";
  sessionId: string; // source session or ""
  item: FeedItem;
}

/* ── message stream ── */
/** a file attached to a user prompt (lands in the workspace .truss-uploads/) */
export interface PromptAttachment {
  name: string;
  /** workspace-root-relative path */
  path: string;
  size: number;
  mime?: string;
}

export interface MsgStart {
  type: "msg.start";
  sessionId: string;
  messageId: string;
  role: "user" | "assistant" | "system";
  at: number;
  /** user prompts only: attached files (transcript chips survive reload) */
  attachments?: PromptAttachment[];
}
export interface MsgChunk {
  type: "msg.chunk";
  sessionId: string;
  messageId: string;
  text: string;
  /** text = visible reply; thinking = model reasoning (rendered as dimmed scaffold) */
  channel?: "text" | "thinking";
}
export interface MsgDone {
  type: "msg.done";
  sessionId: string;
  messageId: string;
  stopReason?: string;
}

/* ── tool lifecycle ── */
export interface ToolCall {
  type: "tool.call";
  sessionId: string;
  toolCallId: string;
  name: string;
  args: unknown;
  /** the llm.call (turn) this tool execution belongs to, when known */
  callId?: string;
}
export interface ToolUpdate {
  type: "tool.update";
  sessionId: string;
  toolCallId: string;
  status: "in_progress";
  output?: string;
}
export interface ToolDone {
  type: "tool.done";
  sessionId: string;
  toolCallId: string;
  ok: boolean;
  durationMs?: number;
  output?: string;
}

/* ── permission round-trip (agent → user) ── */
export interface PermRequest {
  type: "perm.request";
  sessionId: string;
  requestId: string;
  tool: string;
  reason: string;
  options: string[];
}
export interface PermResolve {
  type: "perm.resolve";
  sessionId: string;
  requestId: string;
  choice: string;
}

/* ── per-LLM-call trajectory rows ── */
export interface LlmCallStart {
  type: "llm.call.start";
  sessionId: string;
  callId: string;
  model: string;
  at: number;
  parentToolCallId?: string;
}
export interface LlmCallDone {
  type: "llm.call.done";
  sessionId: string;
  callId: string;
  status: number;
  latencyMs: number;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  cacheRead?: number;
  cacheWrite?: number;
  retryOf?: string;
}

/* ── subagent tree ── */
export interface SubagentSpawn {
  type: "subagent.spawn";
  sessionId: string;
  agentId: string;
  label: string;
  parentAgentId?: string;
}
export interface SubagentDone {
  type: "subagent.done";
  sessionId: string;
  agentId: string;
  ok: boolean;
}

/* ── context occupancy ── */
export interface CtxUsage {
  type: "ctx.usage";
  sessionId: string;
  used: number;
  total: number;
  by?: {
    system?: number;
    tools?: number;
    rules?: number;
    memory?: number;
    conversation?: number;
  };
}

export type ProtoEvent =
  | SessionCreated
  | SessionStateEvent
  | SessionUpdated
  | SessionDeleted
  | TodoUpsert
  | FeedUpsert
  | MsgStart
  | MsgChunk
  | MsgDone
  | ToolCall
  | ToolUpdate
  | ToolDone
  | PermRequest
  | PermResolve
  | LlmCallStart
  | LlmCallDone
  | SubagentSpawn
  | SubagentDone
  | CtxUsage;

export type ProtoEventType = ProtoEvent["type"];

/* host vitals collector (Monitor tab; shared by server + node-agent) */
export { collectMetrics } from "./metrics.js";
export type { HostMetrics } from "./metrics.js";
