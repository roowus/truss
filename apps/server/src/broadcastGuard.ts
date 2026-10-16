import { LINK_WEDGED } from "./remote.js";

/**
 * Broadcast backpressure guard (issue #218, second path).
 *
 * `apps/server/src/index.ts` fans every event out to all connected WS clients.
 * Before this, a client that stopped reading (a stalled browser tab, a wedged
 * tailnet peer) had its frames pile up in the socket's userspace send buffer
 * with NO cap — the exact unbounded-buffering shape as the tunnel queues, and
 * on the same server that must stay alive.
 *
 * POLICY: degrade THAT CLIENT ONLY, never the whole fan-out. A client over
 * budget for the sustained window is closed with LINK_WEDGED (4407) rather
 * than silently dropped from the bus — closing is visible, and the browser
 * reconnects and resyncs from the event log exactly like the tunnel path.
 * Other clients are untouched: one wedged tab must not cost anyone else a
 * frame.
 *
 * `ws@8.21.3` exposes `socket.bufferedAmount` as a cheap synchronous getter —
 * reading it per broadcast costs nothing and needs no timer for the check
 * itself. The sustained window is only consulted when a client is over
 * budget, and it uses an INJECTABLE clock (constraint 1: a test that sleeps
 * 60 s is a test that gets deleted).
 */

/** bytes queued in one client's send buffer before it counts as behind */
export const CLIENT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/** how long a client may stay over budget before it is closed (issue #218) */
export const CLIENT_WEDGE_AFTER_MS = 60_000;

/** the slice of a ws socket this guard needs — keeps it testable with a stub */
export interface GuardedClient {
  /** ws: bytes queued in the kernel/userspace send buffer, sync getter */
  bufferedAmount?: number;
  send: (s: string) => void;
  close: (code?: number, reason?: string) => void;
  on?: (event: string, fn: () => void) => void;
}

interface ClientState {
  /** when the current unbroken backpressure episode began; null while healthy */
  overSince: number | null;
  /** how many frames this guard has closed the client for (0 or 1) */
  closed: boolean;
}

export interface BroadcastGuardOpts {
  maxBufferedBytes?: number;
  wedgeAfterMs?: number;
  /** injectable clock so the wedge window is testable without sleeping */
  now?: () => number;
  onClose?: (reason: string) => void;
}

/**
 * Tracks per-client backpressure across broadcasts. One instance per server;
 * `clients` is the live set index.ts fans out to.
 */
export class BroadcastGuard {
  private state = new WeakMap<GuardedClient, ClientState>();
  private maxBufferedBytes: number;
  private wedgeAfterMs: number;
  private now: () => number;
  private onClose: (reason: string) => void;

  constructor(opts: BroadcastGuardOpts = {}) {
    this.maxBufferedBytes = opts.maxBufferedBytes ?? CLIENT_MAX_BUFFERED_BYTES;
    this.wedgeAfterMs = opts.wedgeAfterMs ?? CLIENT_WEDGE_AFTER_MS;
    this.now = opts.now ?? Date.now;
    this.onClose = opts.onClose ?? (() => {});
  }

  private stateOf(c: GuardedClient): ClientState {
    let s = this.state.get(c);
    if (!s) {
      s = { overSince: null, closed: false };
      this.state.set(c, s);
    }
    return s;
  }

  /**
   * Send one frame to one client, applying the policy. Returns:
   *   "sent"    — delivered normally
   *   "closed"  — the client was over budget for the sustained window and has
   *               just been closed with LINK_WEDGED (drop it from your set)
   *   "skipped" — the client is already closed/skipped; drop it
   *
   * A client that is over budget but NOT yet past the window still gets the
   * frame: the window exists so a brief burst (a large replay) is never
   * mistaken for a dead reader, which is the same blip tolerance the tunnel
   * path relies on.
   */
  deliver(c: GuardedClient, line: string): "sent" | "closed" | "skipped" {
    const s = this.stateOf(c);
    if (s.closed) return "skipped";

    const buffered = typeof c.bufferedAmount === "number" ? c.bufferedAmount : 0;
    const t = this.now();

    if (buffered > this.maxBufferedBytes) {
      /* start the episode on the first over-budget observation — the window
         is measured from when the client FIRST fell behind, not from the
         latest frame */
      if (s.overSince === null) s.overSince = t;
      if (t - s.overSince >= this.wedgeAfterMs) {
        s.closed = true;
        this.onClose(`client over budget for ${Math.round((t - s.overSince) / 1000)}s`);
        try {
          c.close(LINK_WEDGED, "backpressure");
        } catch {
          /* already closing — the close is best-effort; the client is dropped
             from the set either way */
        }
        return "closed";
      }
    } else {
      /* under budget: the episode is over, so the NEXT one gets its own full
         window rather than inheriting this one's start time */
      s.overSince = null;
    }

    try {
      c.send(line);
      return "sent";
    } catch {
      /* a throwing send means the socket is gone — the caller drops it */
      s.closed = true;
      return "skipped";
    }
  }

  /** forget a client the server removed from its set (close handler) */
  forget(c: GuardedClient) {
    this.state.delete(c);
  }

  /** depth/backpressure of every tracked client, for `/api/metrics` */
  stats(clients: Iterable<GuardedClient>): { clients: number; overBudget: number; maxBuffered: number } {
    let over = 0;
    let max = 0;
    let n = 0;
    for (const c of clients) {
      n++;
      const b = typeof c.bufferedAmount === "number" ? c.bufferedAmount : 0;
      if (b > max) max = b;
      if (b > this.maxBufferedBytes) over++;
    }
    return { clients: n, overBudget: over, maxBuffered: max };
  }
}
