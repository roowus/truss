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
  /**
   * Set by sessions.boundedSpawn when the spawn budget gave up on this
   * handle and it landed anyway. Its dispose must free local state but keep
   * its hands off the harness session: on a resume that session is the one
   * a retry is bringing back, and closing it there fails the retry's first
   * turn.
   */
  abandoned?: boolean;
}

export interface HarnessAdapter {
  id: HarnessId;
  capabilities: {
    permissions: boolean;
    subagents: boolean;
    streaming: boolean;
    /** can accept a new prompt while a turn is running (pi: followUp queue) */
    queueWhileRunning: boolean;
  };
  /** models this adapter can offer right now (for the composer model chip) */
  listModels(): Promise<{ provider: string; model: string; label: string }[]>;
  /**
   * One-shot catalog probe for adapters that discover models lazily (from
   * session/new responses): open a throwaway session, harvest its model
   * catalog, close it again. sessions.listModels calls it in the background
   * when the catalog is empty (first boot on a fresh server — issue #101).
   * Resolves true when the catalog changed; never rejects.
   */
  probeModels?(): Promise<boolean>;
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
