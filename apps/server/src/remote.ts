import type { HarnessAdapter, AdapterHandle, SessionOpts } from "./adapters/types.js";
import type { HarnessId, ProtoEvent } from "@truss/proto";

/**
 * Node-agent registry + RemoteAdapter — adapters running on remote hosts,
 * tunneled over one outbound-from-the-agent WebSocket.
 *
 * A connected agent registers its adapters as `pi@<hostId>` etc.
 *
 * Disconnects are BLIP-TOLERANT (issue #100): a dropped tunnel no longer
 * errors the host's sessions wholesale. The agent keeps its harness
 * processes alive across a reconnect and its hello lists them; the server
 * reconciles — sessions the agent still has pick up where they left off,
 * sessions it lost flip to error then, and only then. Sends into an offline
 * tunnel throw (a loud 409 at the route) instead of vanishing.
 */

interface AgentInfo {
  hostId: string;
  hostname: string;
  socket: { send: (s: string) => void; close: () => void; readyState?: number };
  adapters: { id: string; capabilities: HarnessAdapter["capabilities"] }[];
  /** version handshake (issue #100): the agent reports its protocol level
     and the hash of the bundle it runs — skew against the server's current
     bundle is finally visible (installed agents never auto-update) */
  protocol?: number;
  bundleHash?: string;
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
const pendingSpawns = new Map<string, { hostId: string; res: (ok: boolean, error?: string) => void; timer: ReturnType<typeof setTimeout> }>();
/** reqId → metrics resolver (Monitor tab polls through the tunnel) */
const pendingMetrics = new Map<string, { hostId: string; res: (m: unknown) => void }>();
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
        hostId: this.hostId,
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

  /* sends into an offline tunnel must FAIL LOUDLY (issue #100, item 6): the
     old optional-chain dropped the frame on the floor AFTER the user bubble
     was already persisted — a ghost turn. Throwing surfaces a 409 at the
     route, and the session resumes on its own once the agent is back. */
  private socketOrThrow(): AgentInfo["socket"] {
    const agent = agents.get(this.hostId);
    /* registry membership alone is not enough (audit B6): a half-open socket
       (CLOSING/CLOSED, heartbeat hasn't reaped it yet) swallows sends
       silently — ws only reports failure via callback. readyState is
       optional in the type for the test stub; a real ws always has it. */
    if (!agent || (agent.socket.readyState !== undefined && agent.socket.readyState !== 1)) {
      throw new Error(`node-agent ${this.hostId} is offline — the prompt was NOT delivered; it will reconnect on its own, retry in a moment`);
    }
    return agent.socket;
  }

  send(handle: AdapterHandle, text: string) {
    this.socketOrThrow().send(
      JSON.stringify({ type: "send", sessionId: handle.sessionId, text }),
    );
  }

  interrupt(handle: AdapterHandle) {
    this.socketOrThrow().send(
      JSON.stringify({ type: "interrupt", sessionId: handle.sessionId }),
    );
  }

  resolve(handle: AdapterHandle, requestId: string, choice: string) {
    this.socketOrThrow().send(
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

/** an agent connected — register its adapters as `<id>@<host>` harnesses,
    then reconcile its session list against the server's (issue #100) */
export function agentHello(
  hostId: string,
  hostname: string,
  adapterList: { id: string; capabilities: HarnessAdapter["capabilities"] }[],
  socket: { send: (s: string) => void; close: () => void },
  meta: { sessions?: string[]; protocol?: number; bundleHash?: string } = {},
) {
  const existing = agents.get(hostId);
  if (existing) agentBye(hostId, existing.socket);
  agents.set(hostId, { hostId, hostname, socket, adapters: adapterList, protocol: meta.protocol, bundleHash: meta.bundleHash });
  for (const a of adapterList) {
    registerFn?.(`${a.id}@${hostId}` as HarnessId, new RemoteAdapter(hostId, a.id, a.capabilities));
  }

  /* Reconcile (issue #100, item 7): a blip is no longer total session loss.
     The hello's session list is the truth about what survived on the agent:
       - sessions the server still tracks but the agent LOST (its process
         restarted) are really dead — error them now, not at the blip;
       - sessions the agent still RUNS but the server dropped while it was
         away (disposed mid-blip, or a server restart) get a dispose frame so
         the harness process doesn't leak on the remote.
     A protocol-1 agent sends no list — it disposed everything on disconnect,
     so its sessions reconcile against an empty list (the old behavior). */
  const agentHas = new Set(meta.sessions ?? []);
  for (const [sessionId, q] of eventQueues) {
    if (queueHost.get(sessionId) !== hostId) continue;
    if (agentHas.has(sessionId)) continue; // survived the blip — picks up where it left off
    reapSession(sessionId, q, `node-agent ${hostId} lost this session (agent restarted or disposed it)`);
  }
  for (const sessionId of agentHas) {
    if (queueHost.get(sessionId) === hostId) continue; // known and alive
    try {
      socket.send(JSON.stringify({ type: "dispose", sessionId }));
    } catch {
      /* socket dying mid-hello — the next bye/hello cycle reconciles */
    }
  }
  console.log(`[remote] agent ${hostId} (${hostname}) hosting: ${adapterList.map((a) => a.id).join(", ")}`);
}

/** error + close one host session's event stream (the reverse of reattach) */
function reapSession(sessionId: string, q: AsyncQueue<ProtoEvent>, detail: string) {
  q.push({ type: "session.state", sessionId, state: "error", detail });
  q.close();
  eventQueues.delete(sessionId);
  queueHost.delete(sessionId);
  stateSink?.(sessionId, detail);
}

/**
 * Agent disconnected. A network blip is NOT session loss (issue #100): the
 * harnesses stay registered here as live sessions, their event queues stay
 * open, and the reattach handshake at the next hello sorts out what actually
 * died. What must not survive the drop: the host's harness registrations
 * (no new spawns into a dead tunnel) and its in-flight request waiters
 * (they would otherwise sit out a misleading 30s "spawn ack timeout").
 *
 * `socket` guards the reconnect race: the old socket's close event can land
 * after the new connection already registered — it must not reap the NEW
 * agent's state.
 */
export function agentBye(hostId: string, socket?: AgentInfo["socket"]) {
  const agent = agents.get(hostId);
  if (!agent) return;
  if (socket && agent.socket !== socket) return; // stale close from a replaced connection
  agents.delete(hostId);
  for (const a of agent.adapters) {
    unregisterFn?.(`${a.id}@${hostId}` as HarnessId);
  }
  for (const [reqId, p] of pendingSpawns) {
    if (p.hostId !== hostId) continue;
    pendingSpawns.delete(reqId);
    p.res(false, `node-agent ${hostId} disconnected mid-spawn`);
  }
  for (const [reqId, p] of pendingMetrics) {
    if (p.hostId !== hostId) continue;
    pendingMetrics.delete(reqId);
    p.res({ error: `node-agent ${hostId} disconnected` });
  }
  /* protocol-1 agents dispose every harness at close and hello with no
     session list — their sessions can never reattach, so waiting for the
     reconcile just leaks the queues (audit B5). Reap them at the blip, the
     pre-handshake behavior. Protocol-2 sessions stay: the agent kept them
     alive and its next hello reattaches. */
  if (!agent.protocol || agent.protocol < 2) {
    for (const [sessionId, q] of eventQueues) {
      if (queueHost.get(sessionId) !== hostId) continue;
      reapSession(sessionId, q, `node-agent ${hostId} disconnected`);
    }
    console.log(`[remote] agent ${hostId} gone (protocol 1 — its sessions were disposed at close)`);
    return;
  }
  console.log(`[remote] agent ${hostId} away (sessions stay resumable across the blip)`);
}

/** host deleted (or revoked/rotated — issue #100 item 11) — drop the live
   channel NOW. Tokens are only checked at connect, so without this a dead
   host's agent keeps running until it happens to disconnect. Unlike a
   network blip this is final — the agent can never reconnect with the old
   credentials — so its sessions reap here instead of waiting for a
   reconcile that can't come. */
export function dropAgent(hostId: string) {
  const agent = agents.get(hostId);
  if (!agent) return;
  agentBye(hostId, agent.socket);
  for (const [sessionId, q] of eventQueues) {
    if (queueHost.get(sessionId) !== hostId) continue;
    reapSession(sessionId, q, `host ${hostId} was removed or its token changed`);
  }
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
        pending.res(m);
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
    pendingMetrics.set(reqId, {
      hostId,
      res: (m) => {
        clearTimeout(timer);
        res(m);
      },
    });
  });
}

export function listAgents() {
  return [...agents.values()].map((a) => ({
    hostId: a.hostId,
    hostname: a.hostname,
    adapters: a.adapters.map((x) => x.id),
    protocol: a.protocol,
    bundleHash: a.bundleHash,
  }));
}
