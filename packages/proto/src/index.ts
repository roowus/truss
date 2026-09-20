/**
 * Truss internal event schema.
 * ACP-aligned at the harness boundary; extended with per-LLM-call
 * step events for the trajectory view.
 */

export type HarnessId = "pi" | "hermes" | "claude-code" | "dsh" | (string & {});

export interface SessionRef {
  sessionId: string;
  harness: HarnessId;
  cwd: string;
  model?: string;
}

/* ── message stream ── */
export interface MsgChunk { type: "msg.chunk"; sessionId: string; text: string }
export interface MsgDone  { type: "msg.done";  sessionId: string; stopReason?: string }

/* ── tool lifecycle ── */
export interface ToolCall   { type: "tool.call";   sessionId: string; toolCallId: string; name: string; args: unknown }
export interface ToolUpdate { type: "tool.update"; sessionId: string; toolCallId: string; status: "in_progress"; output?: string }
export interface ToolDone   { type: "tool.done";   sessionId: string; toolCallId: string; ok: boolean; durationMs?: number; output?: string }

/* ── permission round-trip (agent → user) ── */
export interface PermRequest { type: "perm.request"; sessionId: string; requestId: string; tool: string; reason: string; options: string[] }
export interface PermResolve { type: "perm.resolve"; sessionId: string; requestId: string; choice: string }

/* ── per-LLM-call trajectory rows ── */
export interface LlmCallStart {
  type: "llm.call.start"; sessionId: string; callId: string;
  model: string; at: number; parentToolCallId?: string;
}
export interface LlmCallDone {
  type: "llm.call.done"; sessionId: string; callId: string;
  status: number; latencyMs: number; tokensIn?: number; tokensOut?: number; costUsd?: number;
  retryOf?: string;
}

/* ── subagent tree ── */
export interface SubagentSpawn { type: "subagent.spawn"; sessionId: string; agentId: string; label: string; parentAgentId?: string }
export interface SubagentDone  { type: "subagent.done";  sessionId: string; agentId: string; ok: boolean }

/* ── context occupancy ── */
export interface CtxUsage {
  type: "ctx.usage"; sessionId: string;
  used: number; total: number;
  by?: { system?: number; tools?: number; rules?: number; memory?: number; conversation?: number };
}

export type ProtoEvent =
  | MsgChunk | MsgDone
  | ToolCall | ToolUpdate | ToolDone
  | PermRequest | PermResolve
  | LlmCallStart | LlmCallDone
  | SubagentSpawn | SubagentDone
  | CtxUsage;

export type ProtoEventType = ProtoEvent["type"];
