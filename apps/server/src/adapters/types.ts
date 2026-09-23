import type { HarnessId, ProtoEvent } from "@truss/proto";

export interface SessionOpts {
  sessionId: string;
  cwd: string;
  model?: string;
  /** provider id within the harness's own config (pi: models.json provider) */
  provider?: string;
  /** resume an existing harness session (the harness's own session id) */
  resumeRef?: string;
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
  };
  /** models this adapter can offer right now (for the composer model chip) */
  listModels(): Promise<{ provider: string; model: string; label: string }[]>;
  spawn(opts: SessionOpts): Promise<AdapterHandle>;
  send(handle: AdapterHandle, text: string): void;
  interrupt(handle: AdapterHandle): void;
  /** answer a permission request (adapters with capabilities.permissions) */
  resolve?(handle: AdapterHandle, requestId: string, choice: string): void;
  events(handle: AdapterHandle): AsyncIterable<ProtoEvent>;
  dispose(handle: AdapterHandle): void;
}
