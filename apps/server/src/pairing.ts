import { randomInt } from "node:crypto";

/**
 * Installer pairing codes (issue #1): the typeable fallback for the 160-char
 * install command — `curl <server>/i/<code> | sh`. Short, lowercase,
 * unambiguous alphabet (no 0/o, 1/i/l), single-use, expiring. Tokens stay in
 * memory only: the code stands for the entry, the hosts table's hash-at-rest
 * rule is untouched (nothing here touches the db).
 */

export interface PairingEntry {
  hostId: string;
  token: string;
  serverUrl: string;
}

export interface Pairing {
  code: string;
  expiresAt: number;
}

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o, 1/i/l
/* 4 chars (issue #111): the code is now typed at a prompt, not embedded in a
   long command, so length drops to the typing floor. The keyspace (~923k)
   stays safe because redeeming is rate-limited per client (below) and every
   code dies after PAIRING_TTL_MS — a full sweep at the rate cap takes months
   while a code lives ten minutes. */
export const PAIRING_CODE_LEN = 4;
export const PAIRING_TTL_MS = 10 * 60 * 1000; // type it promptly, then it dies

const live = new Map<string, { entry: PairingEntry; expiresAt: number }>();

export function mintPairing(entry: PairingEntry, ttlMs = PAIRING_TTL_MS): Pairing {
  /* sweep lazily on mint — no timers, nothing holds the loop */
  const now = Date.now();
  for (const [c, p] of live) if (p.expiresAt <= now) live.delete(c);

  let code = "";
  for (let i = 0; i < PAIRING_CODE_LEN; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  if (live.has(code)) return mintPairing(entry, ttlMs); // collision: remint
  const expiresAt = now + ttlMs;
  live.set(code, { entry, expiresAt });
  return { code, expiresAt };
}

/** redeem exactly once; unknown/expired → undefined (no oracle leaks) */
export function redeemPairing(code: string, now = Date.now()): PairingEntry | undefined {
  const p = live.get(code);
  if (!p) return undefined;
  live.delete(code); // single-use: burned whether or not it was expired
  if (p.expiresAt <= now) return undefined;
  return p.entry;
}

/* ── redeem rate limiting (issue #1: "the redeem endpoint must be
   rate-limited; short codes have a small keyspace by design") — a per-client
   attempt budget, so brute-forcing the keyspace costs real time ── */
export const REDEEM_RATE_WINDOW_MS = 60_000;
export const REDEEM_RATE_MAX = 10; // attempts per window per client

const attempts = new Map<string, { count: number; resetAt: number }>();

/** one attempt against the client's budget — false means answer 429 */
export function redeemRateOk(client: string, now = Date.now()): boolean {
  const a = attempts.get(client);
  if (!a || a.resetAt <= now) {
    /* lazy sweep, same pattern as mintPairing — no timers */
    for (const [k, v] of attempts) if (v.resetAt <= now) attempts.delete(k);
    attempts.set(client, { count: 1, resetAt: now + REDEEM_RATE_WINDOW_MS });
    return true;
  }
  a.count += 1;
  return a.count <= REDEEM_RATE_MAX;
}
