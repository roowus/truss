import type { HarnessAdapter, AdapterHandle, SessionOpts } from "./adapters/types.js";
import type { HarnessId, ProtoEvent } from "@truss/proto";

/**
 * Node-agent registry + RemoteAdapter — adapters running on remote hosts,
 * tunneled over one outbound-from-the-agent WebSocket.
 *
 * A connected agent registers its adapters as `pi@<hostId>` etc. When the
 * agent drops, its adapters unregister and its sessions flip to closed.
 */

interface AgentInfo {
  hostId: string;
  hostname: string;
  socket: { send: (s: string) => void; close: () => void };
  adapters: { id: string; capabilities: HarnessAdapter["capabilities"] }[];
}

interface RemoteHandle extends AdapterHandle {
  hostId: string;
}

const agents = new Map<string, AgentInfo>();
/** sessionId → queue of proto events arriving over the tunnel */
const eventQueues = new Map<string, AsyncQueue<ProtoEvent>>();
/** sessionId → hostId owning the queue, so an agent drop only kills ITS sessions */
const queueHost = new Map<string, string>();
/** reqId → spawn ack resolver (+ timeout so an answered ack frees the timer) */
const pendingSpawns = new Map<string, { res: (ok: boolean, error?: string) => void; timer: ReturnType<typeof setTimeout> }>();
/** reqId → metrics resolver (Monitor tab polls through the tunnel) */
const pendingMetrics = new Map<string, (m: unknown) => void>();
let reqCounter = 0;

type RegisterFn = (id: HarnessId, adapter: HarnessAdapter) => void;
let registerFn: RegisterFn | null = null;
let unregisterFn: ((id: HarnessId) => void) | null = null;
let stateSink: ((sessionId: string, detail: string) => void) | null = null;

export function wireRemoteRegistry(fns: {
  register: RegisterFn;
  unregister: (id: HarnessId) => void;
  sessionGone: (sessionId: string, detail: string) => void;
}) {
  registerFn = fns.register;
  unregisterFn = fns.unregister;
  stateSink = fns.sessionGone;
}

class AsyncQueue<T> {
  private buf: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private done = false;
  push(item: T) {
    if (this.done) return;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.buf.push(item);
  }
  close() {
    this.done = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const head = this.buf.shift();
        if (head !== undefined) return Promise.resolve({ value: head, done: false });
        if (this.done) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((res) => this.waiters.push(res));
      },
    };
  }
}

class RemoteAdapter implements HarnessAdapter {
  id: HarnessId;
  capabilities: HarnessAdapter["capabilities"];

  constructor(
    private hostId: string,
    private adapterId: string,
    caps: HarnessAdapter["capabilities"],
  ) {
    this.id = `${adapterId}@${hostId}`;
    this.capabilities = caps;
  }

  async listModels() {
    return []; // remote model pickers come from the host's own config — v2
  }

  async spawn(opts: SessionOpts): Promise<RemoteHandle> {
    const agent = agents.get(this.hostId);
    if (!agent) throw new Error(`node-agent ${this.hostId} not connected`);

    const reqId = `spawn-${++reqCounter}`;
    const queue = new AsyncQueue<ProtoEvent>();
    eventQueues.set(opts.sessionId, queue);
    queueHost.set(opts.sessionId, this.hostId);

    const ack = new Promise<void>((res, rej) => {
      const timer = setTimeout(() => {
        if (pendingSpawns.delete(reqId)) rej(new Error("spawn ack timeout"));
      }, 30000);
      pendingSpawns.set(reqId, {
        timer,
        res: (ok, error) => {
          clearTimeout(timer); // answered — don't hold the loop open for 30s
          if (ok) res();
          else rej(new Error(error));
        },
      });
    });

    agent.socket.send(
      JSON.stringify({
        type: "spawn",
        reqId,
        adapterId: this.adapterId,
        opts,
      }),
    );
    await ack;

    return { sessionId: opts.sessionId, hostId: this.hostId };
  }

  send(handle: AdapterHandle, text: string) {
    agents.get(this.hostId)?.socket.send(
      JSON.stringify({ type: "send", sessionId: handle.sessionId, text }),
    );
  }

  interrupt(handle: AdapterHandle) {
    agents.get(this.hostId)?.socket.send(
      JSON.stringify({ type: "interrupt", sessionId: handle.sessionId }),
    );
  }

  resolve(handle: AdapterHandle, requestId: string, choice: string) {
    agents.get(this.hostId)?.socket.send(
      JSON.stringify({ type: "resolve", sessionId: handle.sessionId, requestId, choice }),
    );
  }

  events(handle: AdapterHandle): AsyncIterable<ProtoEvent> {
    let q = eventQueues.get(handle.sessionId);
    if (!q) {
      q = new AsyncQueue<ProtoEvent>();
      eventQueues.set(handle.sessionId, q);
      queueHost.set(handle.sessionId, this.hostId);
    }
    return q;
  }

  dispose(handle: AdapterHandle) {
    agents.get(this.hostId)?.socket.send(
      JSON.stringify({ type: "dispose", sessionId: handle.sessionId }),
    );
    const q = eventQueues.get(handle.sessionId);
    if (q) {
      q.close();
      eventQueues.delete(handle.sessionId);
      queueHost.delete(handle.sessionId);
    }
  }
}

/** an agent connected — register its adapters as `<id>@<host>` harnesses */
export function agentHello(
  hostId: string,
  hostname: string,
  adapterList: { id: string; capabilities: HarnessAdapter["capabilities"] }[],
  socket: { send: (s: string) => void; close: () => void },
) {
  const existing = agents.get(hostId);
  if (existing) agentBye(hostId);
  agents.set(hostId, { hostId, hostname, socket, adapters: adapterList });
  for (const a of adapterList) {
    registerFn?.(`${a.id}@${hostId}` as HarnessId, new RemoteAdapter(hostId, a.id, a.capabilities));
  }
  console.log(`[remote] agent ${hostId} (${hostname}) hosting: ${adapterList.map((a) => a.id).join(", ")}`);
}

/** agent disconnected — unregister its harnesses, close its sessions' streams */
export function agentBye(hostId: string) {
  const agent = agents.get(hostId);
  if (!agent) return;
  agents.delete(hostId);
  for (const a of agent.adapters) {
    unregisterFn?.(`${a.id}@${hostId}` as HarnessId);
  }
  /* sessions hosted there are dead — close THEIR event streams, nobody
     else's (a drop used to nuke every queue, including other hosts') */
  for (const [sessionId, q] of eventQueues) {
    if (queueHost.get(sessionId) !== hostId) continue;
    q.push({
      type: "session.state",
      sessionId,
      state: "error",
      detail: `node-agent ${hostId} disconnected`,
    });
    q.close();
    eventQueues.delete(sessionId);
    queueHost.delete(sessionId);
    stateSink?.(sessionId, `node-agent ${hostId} disconnected`);
  }
  console.log(`[remote] agent ${hostId} gone`);
}

/** host deleted — drop the live channel NOW. Tokens are only checked at
   connect, so without this a deleted host's agent keeps running until the
   process restarts (issue #85). agentBye reaps the registry; the socket
   close then re-fires it as a no-op. */
export function dropAgent(hostId: string) {
  const agent = agents.get(hostId);
  if (!agent) return;
  agentBye(hostId);
  try {
    agent.socket.close();
  } catch {
    /* already closing */
  }
}

/** frame router for an agent socket */
export function agentFrame(hostId: string, msg: Record<string, unknown>) {
  switch (msg.type) {
    case "hello":
      /* handled at the route (needs the socket) — should not arrive here */
      return;
    case "spawned": {
      const { reqId, ok, error } = msg as { reqId: string; ok: boolean; error?: string };
      const pending = pendingSpawns.get(reqId);
      if (pending) {
        pendingSpawns.delete(reqId);
        pending.res(ok, error);
      }
      return;
    }
    case "event": {
      const { sessionId, ev } = msg as { sessionId: string; ev: ProtoEvent };
      eventQueues.get(sessionId)?.push(ev);
      return;
    }
    case "metrics": {
      const { reqId, m } = msg as { reqId: string; m: unknown };
      const pending = pendingMetrics.get(reqId);
      if (pending) {
        pendingMetrics.delete(reqId);
        pending(m);
      }
      return;
    }
    default:
      return;
  }
}

/** ask a connected agent for its host vitals (Monitor tab) */
export function requestMetrics(hostId: string, timeoutMs = 3500): Promise<unknown> {
  const agent = agents.get(hostId);
  if (!agent) return Promise.reject(new Error(`node-agent ${hostId} not connected`));
  const reqId = `m-${++reqCounter}`;
  agent.socket.send(JSON.stringify({ type: "metrics_req", reqId }));
  return new Promise((res, rej) => {
    const timer = setTimeout(() => {
      if (pendingMetrics.delete(reqId)) rej(new Error("metrics timeout"));
    }, timeoutMs);
    pendingMetrics.set(reqId, (m) => {
      clearTimeout(timer);
      res(m);
    });
  });
}

export function listAgents() {
  return [...agents.values()].map((a) => ({
    hostId: a.hostId,
    hostname: a.hostname,
    adapters: a.adapters.map((x) => x.id),
  }));
}
