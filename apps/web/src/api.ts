import type { ProtoEvent } from "@truss/proto";

export interface SessionMeta {
  id: string;
  harness: string;
  title: string;
  cwd: string;
  model: string | null;
  project: string | null;
  state: "spawning" | "idle" | "running" | "error" | "closed";
  created_at: number;
  updated_at: number;
  live: boolean;
}

export interface HarnessInfo {
  id: string;
  capabilities: {
    permissions: boolean;
    subagents: boolean;
    streaming: boolean;
    queueWhileRunning: boolean;
  };
}

export interface ModelInfo {
  harness: string;
  provider: string;
  model: string;
  label: string;
}

/** wire frame — seq is the server event-log rowid, used to dedupe replay vs live */
export interface EventFrame {
  seq: number;
  ev: ProtoEvent;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  return res.json() as Promise<T>;
}

export const api = {
  sessions: () => fetch("/api/sessions").then((r) => json<{ sessions: SessionMeta[] }>(r)),
  harnesses: () =>
    fetch("/api/harnesses").then((r) => json<{ harnesses: HarnessInfo[]; models: ModelInfo[] }>(r)),
  events: (id: string) =>
    fetch(`/api/sessions/${id}/events`).then((r) => json<{ events: EventFrame[] }>(r)),
  createSession: (input: {
    harness: string;
    cwd: string;
    model?: string;
    provider?: string;
    title?: string;
    project?: string;
  }) =>
    fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => json<{ session: SessionMeta }>(r)),
  prompt: (id: string, text: string) =>
    fetch(`/api/sessions/${id}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }).then((r) => json<{ ok: true }>(r)),
  interrupt: (id: string) =>
    fetch(`/api/sessions/${id}/interrupt`, { method: "POST" }).then((r) =>
      json<{ ok: true }>(r),
    ),
  createTerminal: (input: { cwd?: string; title?: string }) =>
    fetch("/api/terminals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).then((r) => json<{ id: string; title: string }>(r)),
  closeTerminal: (id: string) =>
    fetch(`/api/terminals/${id}`, { method: "DELETE" }).then((r) => json<{ ok: true }>(r)),
  deleteSession: (id: string, hard = false) =>
    fetch(`/api/sessions/${id}${hard ? "?hard=1" : ""}`, { method: "DELETE" }).then((r) =>
      json<{ ok: true }>(r),
    ),
  resolvePermission: (sessionId: string, requestId: string, choice: string) =>
    fetch(`/api/sessions/${sessionId}/permission`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, choice }),
    }).then((r) => json<{ ok: true }>(r)),
  layout: () => fetch("/api/layout").then((r) => json<{ layout: string | null }>(r)),
  saveLayout: (layout: string) =>
    fetch("/api/layout", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ layout }),
    }).then((r) => json<{ ok: boolean }>(r)),
};
