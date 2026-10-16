/**
 * The node-agent tunnel handshake, in ONE place (issue #217).
 *
 * The protocol level used to be two independent hand-maintained literals —
 * one in the server, one in the node-agent — with nothing comparing them, so
 * they could silently drift and a skew could never be caught. This module is
 * the single source of truth both sides import: the server owns the number
 * (it is what an agent must be able to speak), and the agent reads it.
 *
 * WHEN TO BUMP `TUNNEL_PROTOCOL` (read this before editing any tunnel frame):
 *   bump it in the SAME commit that changes the tunnel wire format — a frame
 *   type added/removed, a field's meaning changed, anything that makes an
 *   older peer half-understand a newer one. Do NOT bump it for a server-side
 *   behavior change that rides fields both sides already send: a bump marks
 *   every installed agent `outdated` (installed agents never auto-update), so
 *   a gratuitous bump banners every real host on upgrade day.
 */

/** the tunnel protocol level the server speaks. See the bump rule above. */
export const TUNNEL_PROTOCOL = 2;

/**
 * Tunnel close codes — the canonical table (issue #217 item 5), so agent
 * logs are greppable and a new code can't quietly collide with an old one.
 * 4400-4406 are the tunnel's own range; anything below is a WebSocket or
 * proxy standard code and must not be reused.
 */
export const TUNNEL_CLOSE = {
  /** the socket spoke before saying hello (protocol-2 requires hello first) */
  HELLO_FIRST: 4400,
  /** a bad/revoked per-host token — fixable on the host, so the agent retries slowly */
  UNAUTHORIZED: 4403,
  /** the host was deleted here; retrying can never succeed, so the agent stops */
  HOST_DELETED: 4404,
  /**
   * the agent speaks a NEWER protocol than this server (issue #217 item 3,
   * and the unparseable-protocol case — a present-but-junk `protocol` field
   * is the same class of "I cannot know what you speak"). The server must
   * never pretend it can speak a protocol it does not know, so the tunnel is
   * refused before the host registers; the agent prints the mismatch and
   * exits nonzero instead of retry-looping.
   *
   * NOTE the asymmetry an absent `protocol` field does NOT fall in here: no
   * field at all is a legacy (protocol-1) agent — older, still accepted, and
   * merely marked outdated. Only a field that is present and not a number is
   * refused. A refactor that flattens "absent" and "junk" together would
   * break every protocol-1 agent in the wild.
   */
  PROTOCOL_TOO_NEW: 4406,
} as const;

export type TunnelCloseCode = (typeof TUNNEL_CLOSE)[keyof typeof TUNNEL_CLOSE];

/**
 * A WebSocket close frame carries the 2-byte code plus at most 123 BYTES of
 * reason (RFC 6455 §5.5.1). `ws` throws on an over-long one, so the socket
 * never closes and the peer hangs instead of learning why — a trap for
 * exactly these human-readable explanations. Truncate (byte-aware, so a
 * multi-byte character can't split into an invalid frame) at the wire edge
 * while the caller logs the full text.
 */
export const TUNNEL_CLOSE_REASON_MAX = 123;

export function tunnelCloseReason(detail: string): string {
  const buf = Buffer.from(detail, "utf8");
  if (buf.byteLength <= TUNNEL_CLOSE_REASON_MAX) return detail;
  /* slice on bytes, then drop any replacement character the cut left behind */
  return buf.subarray(0, TUNNEL_CLOSE_REASON_MAX).toString("utf8").replace(/\uFFFD+$/, "");
}

/** how a peer's announced protocol level relates to ours */
export type TunnelProtocolVerdict = "ok" | "older" | "newer" | "junk";

export interface TunnelProtocolAssessment {
  verdict: TunnelProtocolVerdict;
  /** true only for "newer" and "junk" — the two cases the server refuses */
  refuse: boolean;
  /** the agent's level when we could read one; absent for legacy/junk hellos */
  agentProtocol?: number;
  /** one plain sentence for the log line and the close reason */
  detail: string;
}

/**
 * Classify an agent's announced `protocol` against this server's level
 * (issue #217). Pure — no socket, no registry, no boot — so all five inputs
 * are pinned in one unit test: a number below ours (older), equal (ok),
 * above (newer), absent/`undefined` (legacy — treated as 1, NOT junk), and
 * present-but-not-a-finite-number (junk).
 *
 * The absent-vs-junk split is the subtle part and is deliberate:
 *   - `undefined` → a genuine protocol-1 agent that never sent the field. It
 *     still connects; the server just marks its host `outdated`.
 *   - `"three"`, `null`, `NaN` → someone announced a version we cannot read.
 *     We cannot know what they speak, so we refuse rather than guess.
 */
export function assessTunnelProtocol(
  announced: unknown,
  serverProtocol: number = TUNNEL_PROTOCOL,
): TunnelProtocolAssessment {
  if (announced === undefined) {
    /* legacy pre-handshake agent: no field at all. Older, accepted. */
    return {
      verdict: "older",
      refuse: false,
      agentProtocol: 1,
      detail: `agent speaks protocol 1 (pre-handshake, no version announced); this server speaks ${serverProtocol}`,
    };
  }
  if (typeof announced !== "number" || !Number.isFinite(announced)) {
    return {
      verdict: "junk",
      refuse: true,
      detail: `agent announced an unreadable protocol (${JSON.stringify(announced) ?? String(announced)}); this server speaks ${serverProtocol} and cannot guess`,
    };
  }
  if (announced > serverProtocol) {
    return {
      verdict: "newer",
      refuse: true,
      agentProtocol: announced,
      detail: `agent speaks protocol ${announced}, newer than this server's ${serverProtocol} — upgrade the server, or reinstall this agent from a server that speaks ${announced}`,
    };
  }
  if (announced < serverProtocol) {
    return {
      verdict: "older",
      refuse: false,
      agentProtocol: announced,
      detail: `agent speaks protocol ${announced}, older than this server's ${serverProtocol} — still supported; reinstall the agent to upgrade it`,
    };
  }
  return {
    verdict: "ok",
    refuse: false,
    agentProtocol: announced,
    detail: `agent speaks protocol ${announced}, matching this server`,
  };
}
