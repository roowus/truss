import type { HarnessAdapter, AdapterHandle, SessionOpts } from "./adapters/types.js";
import { isCatalogModel } from "./adapters/model-catalog-cache.js";
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
  socket: { send: (s: string) => void; close: (code?: number, reason?: string) => void; readyState?: number };
  adapters: { id: string; capabilities: HarnessAdapter["capabilities"] }[];
  /** version handshake (issue #100): the agent reports its protocol level
     and the hash of the bundle it runs — skew against the server's current
     bundle is finally visible (installed agents never auto-update) */
  protocol?: number;
  bundleHash?: string;
  /** directory discovery (issue #123): announced at hello — the remote's
     home and its existing projects-family dirs. Old agents send neither and
     degrade to today's behavior (no cwd suggestion). */
  home?: string;
  suggestedCwds?: string[];
}

/** one model a harness offers — the listModels row shape (adapters/types) */
type ModelRow = { provider: string; model: string; label: string };

interface RemoteHandle extends AdapterHandle {
  hostId: string;
}

const agents = new Map<string, AgentInfo>();
/** sessionId → queue of proto events arriving over the tunnel */
const eventQueues = new Map<string, BoundedEventQueue<ProtoEvent>>();
/** sessionId → hostId owning the queue, so an agent drop only kills ITS sessions */
const queueHost = new Map<string, string>();
/** reqId → spawn ack resolver (+ timeout so an answered ack frees the timer) */
const pendingSpawns = new Map<string, { hostId: string; res: (ok: boolean, error?: string) => void; timer: ReturnType<typeof setTimeout> }>();
/** reqId → metrics resolver (Monitor tab polls through the tunnel) */
const pendingMetrics = new Map<string, { hostId: string; res: (m: unknown) => void }>();
/** reqId → models-probe resolver (issue #123): the reqId correlation pattern
   from spawn acks, reused for the tunnel's models.list → models.result */
const pendingModelProbes = new Map<
  string,
  { hostId: string; timer: ReturnType<typeof setTimeout>; res: (models: ModelRow[] | null) => void }
>();
/** hostId → adapterId → probed catalog (issue #123). A disconnect clears the
   host's entry — the picker never offers a dead host's models. */
const hostModelsCache = new Map<string, Map<string, ModelRow[]>>();
/* cap on cached rows per adapter (audit B3) — far above any real catalog
   (pi's synced models.json runs to the mid-hundreds), so it only stops a
   buggy agent from growing the map without bound */
const MAX_CACHED_MODELS = 1000;

/**
 * The probed-models cache (issue #123). `setHostModels(host, null)` is the
 * disconnect path: the whole host entry goes. Without an adapterId the set
 * writes the host-wide ("*") slot — the test-facing form; the tunnel probe
 * always keys by adapter so one harness's catalog never leaks into a
 * sibling's (`pi@box` rows never surface under `claude@box`).
 */
export function setHostModels(hostId: string, models: ModelRow[] | null, adapterId?: string) {
  if (models === null) {
    hostModelsCache.delete(hostId);
    return;
  }
  let per = hostModelsCache.get(hostId);
  if (!per) {
    per = new Map();
    hostModelsCache.set(hostId, per);
  }
  per.set(adapterId ?? "*", models);
}

/** the cached catalog: per adapter when asked, flattened across adapters otherwise */
export function hostModels(hostId: string, adapterId?: string): ModelRow[] {
  const per = hostModelsCache.get(hostId);
  if (!per) return [];
  if (adapterId !== undefined) return per.get(adapterId) ?? [];
  return [...per.values()].flat();
}

let reqCounter = 0;

type RegisterFn = (id: HarnessId, adapter: HarnessAdapter) => void;
let registerFn: RegisterFn | null = null;
let unregisterFn: ((id: HarnessId) => void) | null = null;
let stateSink: ((sessionId: string, detail: string) => void) | null = null;
/* fired once per hello/bye/drop — open clients refetch the tunnel roster
   instead of rendering a stale one (issue #100 manual test) */
let registrySink: (() => void) | null = null;
/* fired when a tunnel probe fills a harness's catalog (issue #123) — open
   pickers refetch, same contract as sessions.listModels' probe broadcast */
let modelsSink: ((harness: string) => void) | null = null;

export function wireRemoteRegistry(fns: {
  register: RegisterFn;
  unregister: (id: HarnessId) => void;
  sessionGone: (sessionId: string, detail: string) => void;
  registryChanged?: () => void;
  modelsChanged?: (harness: string) => void;
}) {
  registerFn = fns.register;
  unregisterFn = fns.unregister;
  stateSink = fns.sessionGone;
  registrySink = fns.registryChanged ?? null;
  modelsSink = fns.modelsChanged ?? null;
}

/**
 * The wedged-link close code (issue #218). Codes 4400-4406 belong to the
 * tunnel's own range (PR #246, packages/proto/src/tunnel.ts), so 4407 sits
 * outside it and cannot collide.
 *
 * RECONCILIATION: #246 was still open when this landed and tunnel.ts does not
 * exist on main yet, so the constant lives here. When #246 merges, move it to
 * that table as `LINK_WEDGED` and re-export it from here — do NOT edit
 * tunnel.ts while #246 is open.
 */
export const LINK_WEDGED = 4407;

/**
 * Queue bounds (issue #218). Tuned from the measured live event log
 * (44,288 rows): median 135 B, p90 1.3 KB, p99 9 KB, max 72 KB, mean 655 B.
 *
 * Bytes are the real budget because a count cap is unfair across that spread
 * — 2000 events is ~270 KB typical but ~144 MB worst case. The count ceiling
 * is a cheap secondary tripwire for a pathological stream of tiny frames
 * (thousands of 20 B chunks would sit under the byte cap yet still be a real
 * queue); it is deliberately NOT a tuned knob.
 *
 * Sizing: 8 MB is ~115x the p99 frame and ~2800x the median — a normal agent
 * turn (even a large transcript replay) stays far below it, so the cap only
 * trips on a genuinely stalled consumer.
 */
export const QUEUE_MAX_BYTES = 8 * 1024 * 1024;
export const QUEUE_MAX_EVENTS = 8192;

/**
 * How long a queue may stay over budget before the link is declared wedged
 * and closed with LINK_WEDGED (issue #218) — the issue's suggested window.
 */
export const WEDGE_AFTER_MS = 60_000;

/**
 * Wire size of one frame in BYTES, which is what the budget claims to measure
 * (audit B6). `String.length` counts UTF-16 code units, so a non-ASCII frame
 * (tool output, non-English replies — routinely 2-3 bytes per character in
 * UTF-8) was charged up to ~3x less than it costs, making the 8 MB budget
 * looser than documented exactly for the frames most likely to be large.
 * Buffer.byteLength is the same encoding the socket writes.
 */
export function frameBytes(ev: unknown): number {
  try {
    const json = JSON.stringify(ev);
    return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
  } catch {
    /* an unserializable payload can't reach the socket either; count it as
       unknown rather than letting the accounting throw in the frame router */
    return 0;
  }
}

/** what the overflow policy did on one push, so the owner can react */
export interface OverflowOutcome {
  /** frames dropped from the front of the queue by this push */
  dropped: number;
  /** this push started an overflow episode — the lag event fires exactly here */
  episodeStarted: boolean;
  /** the queue is back under budget — clears `lagging`, re-arms the lag event */
  recovered: boolean;
  /** over budget continuously for the sustained window — kill the link */
  wedged: boolean;
}

/**
 * A bounded async queue (issue #218).
 *
 * OVERFLOW POLICY (explicit, never silent): when a push would exceed the byte
 * budget or the count ceiling, the OLDEST frames are dropped until it fits —
 * newest frames are the live ones a consumer actually needs. `lagging` is
 * exposed so the owner sets the session flag and emits ONE `session.lag` per
 * episode (not per dropped frame, constraint 2), suppressed until the queue
 * drains back under budget.
 *
 * Dropping is SAFE **only because the frame is persisted before it is
 * enqueued**: `agentFrame`'s event case calls `persistFrame` (wired in
 * index.ts to `persistInboundEvent`) BEFORE `push`, so an evicted frame is
 * already in the SQLite event log and a reconnecting consumer replays it —
 * the log is the recovery path, this queue is not. (Audit B1: the ordering
 * was originally the other way round, because the goLive pump persists what
 * it DRAINS — so a dropped frame was never logged and was lost for good. The
 * queue itself cannot enforce this; the router owns it, and the integration
 * test drives the real router → queue → pump → store path.)
 *
 * The wedge window uses an INJECTABLE clock (`now`): a test that sleeps 60 s
 * is a test that gets deleted (constraint 1).
 */
export class BoundedEventQueue<T> {
  private buf: T[] = [];
  private bytes = 0;
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private done = false;
  /** true while over budget — this IS the `lagging` flag */
  private over = false;
  /** when the current unbroken overflow episode began; null while healthy */
  private overSince: number | null = null;
  private wedged = false;

  constructor(
    private maxBytes: number = QUEUE_MAX_BYTES,
    private maxEvents: number = QUEUE_MAX_EVENTS,
    private wedgeAfterMs: number = WEDGE_AFTER_MS,
    private now: () => number = Date.now,
    private sizeOf: (item: T) => number = frameBytes,
  ) {}

  get depth(): number {
    return this.buf.length;
  }
  get pendingBytes(): number {
    return this.bytes;
  }
  /** the `lagging` flag the issue asks for */
  get lagging(): boolean {
    return this.over;
  }
  get isWedged(): boolean {
    return this.wedged;
  }
  get isClosed(): boolean {
    return this.done;
  }

  /** true when the queue is at or over either bound right now */
  private isOver(): boolean {
    return this.bytes > this.maxBytes || this.buf.length > this.maxEvents;
  }

  /**
   * Push one item, applying the overflow policy. Returns what the policy did
   * — `dropped: 0` and no episode change on the happy path.
   */
  push(item: T): OverflowOutcome {
    if (this.done) return { dropped: 0, episodeStarted: false, recovered: false, wedged: false };

    /* a waiting consumer takes it directly: nothing is ever queued, so the
       budget can't be involved — but the queue may have been over budget and
       this is the moment it catches up */
    const w = this.waiters.shift();
    if (w) {
      w({ value: item, done: false });
      return this.settle();
    }

    /* Was the queue ALREADY over budget before this frame landed? That is the
       question the episode turns on: dropping happens *while* shrinking the
       queue back to fit, so by the time the loop finishes the queue is
       legitimately under budget again and a post-hoc isOver() would miss the
       overflow entirely. Ask before pushing. */
    const wasOver = this.isOver();

    this.buf.push(item);
    this.bytes += this.sizeOf(item);

    let dropped = 0;
    /* drop from the FRONT until both bounds hold — the count ceiling too, or
       a flood of tiny frames under the byte cap would still grow unbounded.
       `buf.length > 1` keeps the frame just pushed. */
    while (this.isOver() && this.buf.length > 1) {
      const old = this.buf.shift() as T;
      this.bytes -= this.sizeOf(old);
      dropped++;
    }
    if (this.bytes < 0) this.bytes = 0;

    /* An episode is live while frames are being dropped OR the queue is over
       budget. Once it starts it stays open until a DRAIN brings the queue
       back under budget (`settle` from the iterator) — that is what makes the
       lag event fire once per episode instead of once per frame. */
    if (dropped > 0 || this.isOver() || wasOver) return this.overflowing_(dropped);
    return this.healthy(dropped);
  }

  /** the happy path: at/under budget, and it was not over before either */
  private healthy(dropped: number): OverflowOutcome {
    const wasLagging = this.over;
    const hadTimer = this.overSince !== null;
    this.over = false;
    this.overSince = null;
    return { dropped, episodeStarted: false, recovered: wasLagging || hadTimer, wedged: false };
  }

  /** the queue is overflowing (dropping or over budget) — open/extend an episode */
  private overflowing_(dropped = 0): OverflowOutcome {
    const episodeStarted = !this.over;
    this.over = true;
    const t = this.now();
    /* the window is measured from the START of this unbroken episode, so a
       queue that keeps overflowing for 60 s is wedged regardless of how many
       frames passed through */
    if (this.overSince === null) this.overSince = t;
    const wedgedNow = !this.wedged && t - this.overSince >= this.wedgeAfterMs;
    if (wedgedNow) this.wedged = true;
    return { dropped, episodeStarted, recovered: false, wedged: wedgedNow };
  }

  /**
   * Recompute the health flags after a DRAIN. This is the only place an
   * episode can close: a consumer taking frames is the recovery signal, and
   * clearing `over` here re-arms the lag event for the next episode.
   */
  private settle(): OverflowOutcome {
    if (!this.isOver() && this.buf.length === 0) {
      /* fully drained — an empty queue is unambiguously recovered */
      const wasLagging = this.over || this.overSince !== null;
      this.over = false;
      this.overSince = null;
      return { dropped: 0, episodeStarted: false, recovered: wasLagging && !this.wedged, wedged: false };
    }
    if (this.isOver()) return this.overflowing_();
    /* under budget but frames remain: the consumer is keeping up, so the
       episode is over even though the queue is not empty */
    const wasLagging = this.over;
    this.over = false;
    this.overSince = null;
    return { dropped: 0, episodeStarted: false, recovered: wasLagging && !this.wedged, wedged: false };
  }

  close() {
    this.done = true;
    this.buf = [];
    this.bytes = 0;
    this.over = false;
    this.overSince = null;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator]() {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const head = this.buf.shift();
        if (head !== undefined) {
          this.bytes -= this.sizeOf(head);
          if (this.bytes < 0) this.bytes = 0;
          notifyQueueHealth(this, this.settle());
          return Promise.resolve({ value: head, done: false });
        }
        if (this.done) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((res) => this.waiters.push(res));
      },
    };
  }
}

/* ── queue health wiring ──────────────────────────────────────────────────
   remote.ts owns the policy; index.ts owns the sockets. These hooks let a
   queue report "I just started lagging / recovered / am wedged" without
   remote.ts importing the WS layer (which would be a cycle). */

export interface QueueHealth {
  /** an overflow episode began — emit session.lag once, set `lagging` */
  onLag: (sessionId: string, info: { depth: number; bytes: number }) => void;
  /** drained back under budget — clear `lagging`, no event (constraint 2) */
  onRecovered: (sessionId: string) => void;
  /** over budget for the sustained window — close the link with LINK_WEDGED */
  onWedged: (sessionId: string) => void;
}

let queueHealth: QueueHealth | null = null;

export function wireQueueHealth(h: QueueHealth | null) {
  queueHealth = h;
}

/**
 * Write one tunnelled frame to the durable event log (issue #218, audit B1).
 * Injected by index.ts and pointed at the session sink's persistence, because
 * remote.ts must not import the store directly (module cycle). It MUST be set
 * for the drop-oldest policy to be safe: a frame is persisted here on receipt,
 * BEFORE the live queue can evict it.
 */
let persistFrame: ((sessionId: string, ev: ProtoEvent) => void) | null = null;

/** sessions we have already warned about for post-teardown frames (one log line
    each). Bounded: this is a log-dedup convenience, and an unbounded Set would
    reintroduce exactly the "grows forever under a misbehaving producer" shape
    issue #218 exists to remove. Oldest entries fall out first. */
const warnedNoQueue = new Set<string>();
const WARNED_NO_QUEUE_MAX = 1000;
function warnNoQueueOnce(sessionId: string) {
  if (warnedNoQueue.has(sessionId)) return;
  if (warnedNoQueue.size >= WARNED_NO_QUEUE_MAX) {
    const oldest = warnedNoQueue.values().next().value;
    if (oldest !== undefined) warnedNoQueue.delete(oldest);
  }
  warnedNoQueue.add(sessionId);
  console.warn(
    `[remote] dropping tunnel frames for ${sessionId}: no live queue (never spawned, disposed, or wedged-closed)`,
  );
}

export function wireFramePersistence(fn: ((sessionId: string, ev: ProtoEvent) => void) | null) {
  persistFrame = fn;
}

/** the queue class is generic and session-agnostic; the id is attached here */
const queueOwner = new WeakMap<object, string>();

function notifyQueueHealth(q: BoundedEventQueue<any>, outcome: OverflowOutcome) {
  const sessionId = queueOwner.get(q);
  if (!sessionId) return;
  if (outcome.episodeStarted) queueHealth?.onLag(sessionId, { depth: q.depth, bytes: q.pendingBytes });
  if (outcome.recovered) queueHealth?.onRecovered(sessionId);
  if (outcome.wedged) queueHealth?.onWedged(sessionId);
}

/**
 * Test-only override of the wedge window for queues created from here on.
 * The window is 60 s in production; a suite cannot sleep that long, and the
 * only honest way to exercise the REAL onWedged → close(4407) wiring (rather
 * than hand-calling the teardown) is to shorten it. `null` restores default.
 */
let queueWedgeWindowOverride: number | null = null;

export function setQueueWedgeWindowForTest(ms: number | null) {
  queueWedgeWindowOverride = ms;
}

/** create a bounded queue already bound to a session's health reporting */
function sessionQueue(sessionId: string): BoundedEventQueue<ProtoEvent> {
  const q =
    queueWedgeWindowOverride === null
      ? new BoundedEventQueue<ProtoEvent>()
      : new BoundedEventQueue<ProtoEvent>(QUEUE_MAX_BYTES, QUEUE_MAX_EVENTS, queueWedgeWindowOverride);
  queueOwner.set(q, sessionId);
  return q;
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

  /* the catalog is whatever the last tunnel probe brought back (issue #123)
     — empty until the agent answers a models.list, cleared when the host
     drops, so the picker never offers a dead host's models */
  async listModels() {
    return hostModels(this.hostId, this.adapterId);
  }

  /**
   * Ask the agent over the tunnel what this adapter can offer (issue #123).
   * Rides the same trigger as the other lazy catalogs (POST
   * /api/harnesses/probe → sessions.listModels({ probe: true })) and also
   * fires once per hello so a freshly connected host fills in without
   * waiting for a dialog. Resolves true when the catalog changed; an agent
   * that predates the probe never answers and times out to false — old
   * agents degrade to today's bare default, no crash.
   */
  async probeModels(): Promise<boolean> {
    const agent = agents.get(this.hostId);
    if (!agent || (agent.socket.readyState !== undefined && agent.socket.readyState !== 1)) return false;
    const reqId = `models-${++reqCounter}`;
    const models = await new Promise<ModelRow[] | null>((res) => {
      const timer = setTimeout(() => {
        if (pendingModelProbes.delete(reqId)) res(null); // pre-probe agent — no answer coming
      }, 5000);
      pendingModelProbes.set(reqId, {
        hostId: this.hostId,
        timer,
        res: (m) => {
          clearTimeout(timer);
          res(m);
        },
      });
      agent.socket.send(JSON.stringify({ type: "models.list", reqId, adapterId: this.adapterId }));
    });
    if (!models) return false;
    const before = hostModels(this.hostId, this.adapterId);
    setHostModels(this.hostId, models, this.adapterId);
    return JSON.stringify(before) !== JSON.stringify(models);
  }

  async spawn(opts: SessionOpts): Promise<RemoteHandle> {
    /* the guard covers spawn too (audit round 5): a half-open socket here
       would eat the spawn frame and leave the caller waiting out the full
       30s "ack timeout" lie — the exact wait item 10 targeted */
    const socket = this.socketOrThrow();

    const reqId = `spawn-${++reqCounter}`;
    const queue = sessionQueue(opts.sessionId);
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

    socket.send(
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
      throw new Error(`node-agent ${this.hostId} is offline — the frame was NOT delivered; it reconnects on its own, retry in a moment`);
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
      q = sessionQueue(handle.sessionId);
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
  socket: AgentInfo["socket"],
  meta: { sessions?: string[]; protocol?: number; bundleHash?: string; home?: string; suggestedCwds?: string[] } = {},
) {
  const existing = agents.get(hostId);
  if (existing) agentBye(hostId, existing.socket);
  agents.set(hostId, {
    hostId,
    hostname,
    socket,
    adapters: adapterList,
    protocol: meta.protocol,
    bundleHash: meta.bundleHash,
    home: meta.home,
    suggestedCwds: meta.suggestedCwds,
  });
  for (const a of adapterList) {
    const adapter = new RemoteAdapter(hostId, a.id, a.capabilities);
    registerFn?.(`${a.id}@${hostId}` as HarnessId, adapter);
    /* fill the catalog right at hello (issue #123): the picker's probe ask
       is deliberately gated behind a JSON content-type (CSRF hardening), so
       waiting for it would leave a connected host model-less until someone
       opens the dialog. Background, never in the hello's path; a pre-probe
       agent just times out and stays at the bare default. */
    void adapter.probeModels().then(
      (changed) => {
        if (changed) modelsSink?.(`${a.id}@${hostId}`);
      },
      () => undefined,
    );
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
  registrySink?.();
}

/** error + close one host session's event stream (the reverse of reattach) */
function reapSession(sessionId: string, q: BoundedEventQueue<ProtoEvent>, detail: string) {
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
  /* the probed catalog dies with the tunnel (issue #123): no stale offers
     from a host that is gone. In-flight probes resolve empty instead of
     waiting out their timeout. */
  setHostModels(hostId, null);
  for (const [reqId, p] of pendingModelProbes) {
    if (p.hostId !== hostId) continue;
    pendingModelProbes.delete(reqId);
    p.res(null);
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
    registrySink?.();
    return;
  }
  console.log(`[remote] agent ${hostId} away (sessions stay resumable across the blip)`);
  registrySink?.();
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
      const q = eventQueues.get(sessionId);
      if (!q) {
        /* No queue means this session is not live here: never spawned, already
           disposed, or torn down by the wedge close. The frame is DROPPED, and
           audit B2's point stands — that must not be a silent swallow. It is
           not persisted either: writing frames for a session this server no
           longer tracks would resurrect transcript entries for a session the
           agent was told to dispose. Logged once per session so a chatty
           post-teardown agent cannot flood the log. */
        warnNoQueueOnce(sessionId);
        return;
      }
      /* PERSIST FIRST, THEN ENQUEUE (issue #218, audit B1). The whole
         drop-oldest policy rests on "the event log is the recovery path", and
         that is only true if the frame is in the log BEFORE the queue can
         evict it. It was not: persistence happens in the goLive pump
         (sessions.ts sink()), which DRAINS this queue — so a frame dropped by
         `push` was never persisted and was lost for good.
         `persistFrame` is the caller-supplied write into the durable log
         (wired in index.ts to the same store sink the pump uses). It is
         idempotent-by-contract: the pump's later sink() re-persisting the
         frame is handled by the caller, so a drained frame is not written
         twice. */
      persistFrame?.(sessionId, ev);
      /* the overflow policy runs here (issue #218): the queue drops the
         oldest frames if the consumer is behind, and reports whether that
         started/ended an episode or wedged the link — the health sink emits
         the ONE session.lag and owns the close. Push only returns the happy
         outcome when a consumer was already waiting, so nothing is queued. */
      notifyQueueHealth(q, q.push(ev));
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
    case "models.result": {
      /* a probe answer (issue #123) — resolve the waiting probeModels; an
         unknown reqId (late answer after timeout/bye) drops harmlessly.
         Rows are shape-guarded and capped (audit B3): the tunnel is a trust
         boundary, and a buggy agent must not put junk rows into the picker
         (a row missing `label` renders "undefined/undefined") or bloat the
         cache without bound. */
      const { reqId, models } = msg as { reqId: string; models?: unknown };
      const pending = pendingModelProbes.get(reqId);
      if (pending) {
        pendingModelProbes.delete(reqId);
        pending.res(Array.isArray(models) ? models.filter(isCatalogModel).slice(0, MAX_CACHED_MODELS) : []);
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

/**
 * Queue depth per tunnelled session (issue #218, metrics ask): "is the tunnel
 * backed up" is answerable from `/api/metrics` without a probe round-trip.
 * Cheap and synchronous — the queue keeps its own counters.
 */
export function queueStats(): {
  sessionId: string;
  hostId: string | null;
  depth: number;
  bytes: number;
  lagging: boolean;
}[] {
  return [...eventQueues].map(([sessionId, q]) => ({
    sessionId,
    hostId: queueHost.get(sessionId) ?? null,
    depth: q.depth,
    bytes: q.pendingBytes,
    lagging: q.lagging,
  }));
}

/**
 * The wedge kill (issue #218): a session's consumer has been behind for the
 * sustained window, so stop buffering forever and CLOSE THE LINK with the
 * dedicated code (audit B2 — an earlier revision only deleted the map entry
 * and logged that it had closed, which was false, and left the agent
 * streaming into a router that silently discarded every later frame).
 *
 * The tunnel is HOST-WIDE, so the close is scoped honestly:
 *   - the wedged session is disposed on the agent (`dispose` frame) so it
 *     stops producing for a link nobody is draining;
 *   - if that host has NO other live session, the whole tunnel is closed with
 *     LINK_WEDGED — the link itself is the thing that was wedged;
 *   - if the host has other live sessions, closing the socket would kill
 *     THEIR links too, which is exactly the "one wedged host must degrade
 *     that session only" rule. Those siblings keep their tunnel; the wedged
 *     session is gone and the agent is told to dispose just it.
 *
 * Either way the session is not "lost" in the data sense: the frames are in
 * the SQLite event log (persisted on receipt — see `wireFramePersistence`),
 * so the transcript replays; the harness is disposed because a producer whose
 * consumer is gone is the thing that was wedged.
 */
export function dropWedgedQueue(sessionId: string) {
  const q = eventQueues.get(sessionId);
  if (!q) return;
  const hostId = queueHost.get(sessionId);
  eventQueues.delete(sessionId);
  queueHost.delete(sessionId);
  q.close();

  const siblings = hostId
    ? [...queueHost.values()].filter((h) => h === hostId).length
    : 0;
  const agent = hostId ? agents.get(hostId) : undefined;

  if (agent) {
    /* stop the producer for this session first — otherwise it keeps sending
       frames for a queue that no longer exists */
    try {
      agent.socket.send(JSON.stringify({ type: "dispose", sessionId }));
    } catch {
      /* socket already dying — the close below is the real signal */
    }
    if (siblings === 0) {
      /* no other session needs this tunnel: it is the wedged link, close it
         with the dedicated code. The blip-tolerant reconnect path (#100)
         brings the agent back and its next hello reconciles. */
      try {
        agent.socket.close(LINK_WEDGED, "session queue wedged: consumer not draining");
      } catch {
        /* already closing */
      }
      console.warn(
        `[remote] session ${sessionId} queue wedged (over budget for ${WEDGE_AFTER_MS / 1000}s) — closed tunnel to ${hostId} with ${LINK_WEDGED}`,
      );
      return;
    }
    console.warn(
      `[remote] session ${sessionId} queue wedged (over budget for ${WEDGE_AFTER_MS / 1000}s) — disposed on ${hostId}, tunnel kept for ${siblings} sibling session(s)`,
    );
    return;
  }
  console.warn(`[remote] session ${sessionId} queue wedged — queue torn down (agent already offline)`);
}

export function listAgents() {
  return [...agents.values()].map((a) => ({
    hostId: a.hostId,
    hostname: a.hostname,
    adapters: a.adapters.map((x) => x.id),
    protocol: a.protocol,
    bundleHash: a.bundleHash,
    /* directory discovery (issue #123): home as announced, and the ONE
       suggestion the New Session dialog prefills — the first
       projects-family dir when the agent found one, else home. Old agents
       announce neither and simply carry no suggestion. */
    home: a.home,
    suggestedCwd: a.suggestedCwds?.find((d) => d !== a.home) ?? a.home,
  }));
}
