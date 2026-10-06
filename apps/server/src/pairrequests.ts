import { randomBytes } from "node:crypto";
import { createHost, verifyAgentToken } from "./hosts.js";

/**
 * Auto-pairing (issue #111, review rounds): the WhatsApp/Discord shape. The
 * new device downloads the installer, runs it, and the installer announces
 * itself here; the trust decision happens on the surface the user is
 * already sitting at — the Truss UI's Allow click — so the remote does zero
 * typing: download, run, done. No codes, no URLs, no prompts.
 *
 * The gate is the human click, and it has to be: anyone who can reach this
 * server (tailnet, or LAN when bound wide) could otherwise register a host
 * and start receiving session traffic. A request carries only self-reported
 * metadata, expires quickly, and hands out credentials exactly once.
 *
 *   agent:  POST /api/pair/request → 202 { id }   (rate-limited)
 *   ui:     GET /api/hosts → pendingPair[]        → Allow / Deny click
 *   agent:  GET /api/pair/request/<id>            (polls, 2s)
 *           pending → approved { hostId, token, serverUrl } (first read
 *           burns the credentials) → denied | 410 (expired/unknown)
 *
 * Request ids are 128-bit random, so polling someone else's request is
 * infeasible. State is in-memory like the pairing codes: a restart forgets
 * pending requests, and the agent's 10-minute poll window dies with them.
 */

export interface PairRequestMeta {
  hostname: string;
  os: string;
  tailscaleIp?: string;
}

export interface PairRequestView {
  id: string;
  hostname: string;
  os: string;
  tailscaleIp?: string;
  /* the requester's ACTUAL source address (audit round 8, B3): everything
     else on the row is self-reported by the announcing device — this is the
     one piece of evidence the operator can trust before clicking Allow */
  sourceIp: string;
  expiresAt: number;
}

type PairRequest = PairRequestView & {
  serverUrl: string; // the address the agent reached us at — it demonstrably works
  status: "pending" | "approved" | "denied";
  approved?: { hostId: string; token: string };
  delivered?: boolean; // credentials handed over already — a second read gets 410
};

export const PAIR_REQUEST_TTL_MS = 10 * 60 * 1000; // approve promptly, then it dies

const requests = new Map<string, PairRequest>();

function sweep(now: number) {
  for (const [id, r] of requests) if (r.expiresAt <= now) requests.delete(id);
}

let broadcast: ((event: "requested" | "resolved", view: PairRequestView) => void) | null = null;
export function setPairBroadcaster(fn: typeof broadcast) {
  broadcast = fn;
}
const view = (r: PairRequest): PairRequestView => ({
  id: r.id,
  hostname: r.hostname,
  os: r.os,
  tailscaleIp: r.tailscaleIp,
  sourceIp: r.sourceIp,
  expiresAt: r.expiresAt,
});
const announce = (event: "requested" | "resolved", r: PairRequest) => broadcast?.(event, view(r));

/* ── creation rate limiting (same shape as the redeem guard): a request is
   cheap and secret-free, but an unauthenticated endpoint still gets a
   per-client budget so nobody floods the UI with fake devices ── */
export const PAIR_REQUEST_RATE_WINDOW_MS = 60_000;
export const PAIR_REQUEST_RATE_MAX = 5;

const attempts = new Map<string, { count: number; resetAt: number }>();

/** one attempt against the client's budget — false means answer 429 */
export function pairRequestRateOk(client: string, now = Date.now()): boolean {
  const a = attempts.get(client);
  if (!a || a.resetAt <= now) {
    for (const [k, v] of attempts) if (v.resetAt <= now) attempts.delete(k);
    attempts.set(client, { count: 1, resetAt: now + PAIR_REQUEST_RATE_WINDOW_MS });
    return true;
  }
  a.count += 1;
  return a.count <= PAIR_REQUEST_RATE_MAX;
}

/** display metadata is self-reported: trim to plain printable characters */
const clean = (s: unknown): string => (typeof s === "string" ? s.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 80) : "");

export function createPairRequest(meta: PairRequestMeta, serverUrl: string, sourceIp: string): PairRequestView {
  const now = Date.now();
  sweep(now);
  const r: PairRequest = {
    id: randomBytes(16).toString("hex"),
    hostname: clean(meta.hostname) || "unknown device",
    os: clean(meta.os) || "unknown",
    tailscaleIp: clean(meta.tailscaleIp) || undefined,
    sourceIp,
    serverUrl,
    expiresAt: now + PAIR_REQUEST_TTL_MS,
    status: "pending",
  };
  requests.set(r.id, r);
  announce("requested", r);
  return view(r);
}

/** the UI's pending list, oldest first */
export function listPairRequests(): PairRequestView[] {
  sweep(Date.now());
  return [...requests.values()]
    .filter((r) => r.status === "pending")
    .map(view);
}

/**
 * The agent's poll. Approved credentials are delivered ONCE (the first read
 * burns them — the agent retries on crash-before-write, so a second read
 * must not hand them out again); denied stays visible until expiry so the
 * agent gets the real answer; unknown/expired/consumed → undefined (410).
 */
export function readPairRequest(id: string):
  | { status: "pending" }
  | { status: "denied" }
  | { status: "approved"; hostId: string; token: string; serverUrl: string }
  | undefined {
  sweep(Date.now());
  const r = requests.get(id);
  if (!r) return undefined;
  if (r.status === "pending") return { status: "pending" };
  if (r.status === "denied") return { status: "denied" };
  if (r.delivered || !r.approved) return undefined; // approved but already read
  r.delivered = true;
  return { status: "approved", hostId: r.approved.hostId, token: r.approved.token, serverUrl: r.serverUrl };
}

/** the Allow click, two shapes:
   - with the wizard's hostId + its in-memory plaintext token (verified
     against the host's hash like every delivery route), the request pairs
     INTO the wizard's own host, so the wizard's waiting screen is the one
     that flips (manual test: a fresh host per approval left the wizard's
     host waiting forever — two records for one device);
   - bare (the sidebar's standalone row), create the host + token exactly
     like the add-host wizard.
   Either way the credentials park for the agent's next poll. Undefined when
   the request is gone or already decided; "token-mismatch" when the
   wizard's token doesn't match the host it names. */
export function approvePairRequest(
  id: string,
  into?: { hostId: string; token: string },
): { hostId: string } | "token-mismatch" | undefined {
  sweep(Date.now());
  const r = requests.get(id);
  if (!r || r.status !== "pending") return undefined;
  let hostId: string;
  let token: string;
  if (into) {
    if (!verifyAgentToken(into.hostId, into.token, "")) return "token-mismatch";
    hostId = into.hostId;
    token = into.token;
  } else {
    const created = createHost(r.hostname, `auto-paired from ${r.tailscaleIp ?? "unknown address"}`);
    hostId = created.host.id;
    token = created.token;
  }
  r.status = "approved";
  r.approved = { hostId, token };
  announce("resolved", r);
  return { hostId };
}

export function denyPairRequest(id: string): boolean {
  sweep(Date.now());
  const r = requests.get(id);
  if (!r || r.status !== "pending") return false;
  r.status = "denied";
  announce("resolved", r);
  return true;
}
