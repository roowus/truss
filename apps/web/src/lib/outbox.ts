/**
 * Send outbox (issue #216). Every mutating call that can be harmfully
 * double-fired — a prompt, an interrupt, a permission answer — gets a client
 * op id that is KEPT until the server acks it. If the ack never arrives (the
 * response was lost, or the socket went down mid-flight), the entry is
 * replayed on reconnect with the SAME op id, and the server's ledger returns
 * the original result instead of delivering a second turn.
 *
 * Pure helpers only, no React and no storage: the store owns the instance and
 * the persistence, this file owns the state machine. Types are kept narrow so
 * the reducer is directly testable (apps/web/test/outbox.test.ts).
 */

export type OpKind = "prompt" | "interrupt" | "perm";

export interface OutboxEntry {
  /** the idempotency key sent to the server; stable across replays */
  opId: string;
  kind: OpKind;
  sessionId: string;
  /** when the entry was first queued (epoch ms) — drives the staleness cap */
  at: number;
  /** how many times we have fired this op (1 = first attempt) */
  attempts: number;
  /** flattened request payload: kind-specific, JSON-safe */
  body: Record<string, unknown>;
  /** set when at least one attempt has been replayed after a reconnect, so
      the transcript can say "retried" without guessing */
  replayed?: boolean;
}

export interface OutboxState {
  entries: OutboxEntry[];
}

export const emptyOutbox: OutboxState = { entries: [] };

/**
 * A prompt that has sat unacked this long is dropped rather than replayed.
 * The server's ledger is 24 h and the outbox must be the SHORTER window: a
 * replay the server has already forgotten would deliver a real duplicate, so
 * anything older than this stops being a retry and becomes abandoned work.
 * 10 minutes is longer than any reconnect a user would sit through.
 */
export const OUTBOX_MAX_AGE_MS = 10 * 60 * 1000;

/** hard bound on the queue: past this the OLDEST entries are dropped, so a
 *  long offline stretch cannot grow memory without limit */
export const OUTBOX_CAP = 50;

/** mint an op id. crypto.randomUUID is the ask; the fallback exists for
    non-secure origins, where the browser withholds it. */
export function newOpId(): string {
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  /* not a security token — it only has to not collide within one outbox */
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Queue an op. Returns a new state; the caller sends it immediately.
 *
 * Re-enqueueing an op id that is ALREADY queued keeps its original `at` and
 * its attempt count. That matters because every replay re-enters here: if the
 * clock restarted each time, an op the server keeps refusing would never age
 * out (audit round 2, B1) — the 10-minute cap would be unreachable, the entry
 * would keep sliding to the tail so the cap evicted live sends ahead of it,
 * and the window in which the server may have forgotten the op would reopen
 * indefinitely, which is the duplicate this whole file exists to prevent.
 */
export function enqueue(
  state: OutboxState,
  entry: { opId: string; kind: OpKind; sessionId: string; body: Record<string, unknown>; at?: number; attempts?: number; replayed?: boolean },
): OutboxState {
  const prev = state.entries.find((e) => e.opId === entry.opId);
  const next: OutboxEntry = {
    opId: entry.opId,
    kind: entry.kind,
    sessionId: entry.sessionId,
    /* first queue: now. Re-queue (a replay): keep the original stamp, so the
       age cap measures the op's real lifetime, not the last attempt's */
    at: prev?.at ?? entry.at ?? Date.now(),
    /* each enqueue is one more real fire of this op */
    attempts: (prev?.attempts ?? 0) + 1,
    body: entry.body,
    ...(prev?.replayed || entry.replayed ? { replayed: true } : {}),
  };
  const entries = [...state.entries.filter((e) => e.opId !== next.opId), next];
  /* cap by oldest first — the newest sends are the ones a user is waiting on */
  const trimmed = entries.length > OUTBOX_CAP ? entries.slice(entries.length - OUTBOX_CAP) : entries;
  return { entries: trimmed };
}

/** retire an op — the ack landed, so a later reconnect must not replay it */
export function retire(state: OutboxState, opId: string): OutboxState {
  const entries = state.entries.filter((e) => e.opId !== opId);
  return entries.length === state.entries.length ? state : { entries };
}

/**
 * What to replay now: every entry still queued, marked as a replay and with
 * its attempt count bumped. Entries past the age cap are dropped instead —
 * see OUTBOX_MAX_AGE_MS for why replaying them would be wrong. The attempt
 * count is left for `enqueue` to settle, so a replay does not inflate it.
 */
export function pending(state: OutboxState, now = Date.now()): { replay: OutboxEntry[]; state: OutboxState } {
  const keep: OutboxEntry[] = [];
  const replay: OutboxEntry[] = [];
  for (const e of state.entries) {
    if (now - e.at > OUTBOX_MAX_AGE_MS) continue; // abandoned, not retried
    replay.push({ ...e, replayed: true });
    keep.push({ ...e, replayed: true });
  }
  return { replay, state: { entries: keep } };
}

/** does this op id still need an ack? */
export function has(state: OutboxState, opId: string): boolean {
  return state.entries.some((e) => e.opId === opId);
}

/** how many times this op id has been fired, 0 when it is not queued */
export function attempts(state: OutboxState, opId: string): number {
  return state.entries.find((e) => e.opId === opId)?.attempts ?? 0;
}

/**
 * The transcript note a replayed send earns. Deliberately only reachable from
 * a genuine replay path — the store calls it for entries that came back from
 * `pending()`, so a normal first send can never show this.
 */
export const RETRY_NOTE = "Retried after reconnect";
