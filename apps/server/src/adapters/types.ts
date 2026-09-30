import type { HarnessId, ProtoEvent } from "@truss/proto";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";

export interface SessionOpts {
  sessionId: string;
  cwd: string;
  model?: string;
  /** provider id within the harness's own config (pi: models.json provider) */
  provider?: string;
  /** resume an existing harness session (the harness's own session id) */
  resumeRef?: string;
  /** reasoning effort for thinking-capable models (issue #27) — travels with
     model+provider through create/switch/resume; null = harness default */
  effort?: string | null;
}

/**
 * A session cwd that no longer exists must not kill the spawn with ENOENT —
 * fall back to the server user's home and tell the caller (so the UI can
 * surface "working directory vanished" instead of a cryptic crash).
 */
export function resolveCwd(cwd: string): { cwd: string; fellBack: boolean } {
  try {
    if (existsSync(cwd) && statSync(cwd).isDirectory()) return { cwd, fellBack: false };
  } catch {
    /* unreadable → fall back */
  }
  return { cwd: homedir(), fellBack: true };
}

/** surface a cwd fallback in the chat transcript */
export function cwdFallbackNote(push: (ev: ProtoEvent) => void, sessionId: string, from: string, to: string) {
  const id = `m-sys-${Date.now()}`;
  push({ type: "msg.start", sessionId, messageId: id, role: "system", at: Date.now() });
  push({
    type: "msg.chunk",
    sessionId,
    messageId: id,
    text: `working directory ${from} no longer exists — running in ${to} instead`,
  });
  push({ type: "msg.done", sessionId, messageId: id });
}

export interface AdapterHandle {
  /** adapter-local opaque state */
  readonly sessionId: string;
  /** the harness's own session id, when known — persisted for resume */
  harnessRef?: string;
}

export interface HarnessAdapter {
  id: HarnessId;
  capabilities: {
    permissions: boolean;
    subagents: boolean;
    streaming: boolean;
    /** can accept a new prompt while a turn is running (pi: followUp queue) */
    queueWhileRunning: boolean;
    /** consumes SessionOpts.effort (issue #27). Absent or false means the
       harness discards it, so the UI hides the effort selector rather than
       offering a level that only restarts the session to no effect. */
    effort?: boolean;
  };
  /** models this adapter can offer right now (for the composer model chip) */
  listModels(): Promise<{ provider: string; model: string; label: string }[]>;
  spawn(opts: SessionOpts): Promise<AdapterHandle>;
  send(handle: AdapterHandle, text: string): void;
  interrupt(handle: AdapterHandle): void;
  /** live model switch (pi: set_model). Adapters without it get the
     dispose+respawn treatment from sessions.switchModel instead. */
  setModel?(handle: AdapterHandle, provider: string | undefined, model: string): Promise<void>;
  /** answer a permission request (adapters with capabilities.permissions) */
  resolve?(handle: AdapterHandle, requestId: string, choice: string): void;
  events(handle: AdapterHandle): AsyncIterable<ProtoEvent>;
  dispose(handle: AdapterHandle): void;
}
