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
const CODE_LEN = 6;
export const PAIRING_TTL_MS = 10 * 60 * 1000; // type it promptly, then it dies

const live = new Map<string, { entry: PairingEntry; expiresAt: number }>();

export function mintPairing(entry: PairingEntry, ttlMs = PAIRING_TTL_MS): Pairing {
  /* sweep lazily on mint — no timers, nothing holds the loop */
  const now = Date.now();
  for (const [c, p] of live) if (p.expiresAt <= now) live.delete(c);

  let code = "";
  for (let i = 0; i < CODE_LEN; i++) code += ALPHABET[randomInt(ALPHABET.length)];
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
