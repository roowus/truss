/**
 * Tunnel close handling (issue #217). The agent's `close` listener used to
 * be one long inline chain in index.ts: 4404 stops, 4403 watches slowly,
 * everything else is a blip. Protocol refusal (4406) joins that chain, and
 * the decisions are exactly the kind that must not drift — a wrong verdict
 * means either a retry loop that never succeeds, or an agent that dies when
 * it should have reconnected.
 *
 * Pure builder, same shape as dialHint.ts: the socket listener asks here
 * what a close code MEANS, and executes the answer. No socket, no timers,
 * no process.exit in the decision itself — so every code is pinnable
 * without opening a connection.
 */

import { TUNNEL_CLOSE } from "@truss/proto";

export type TunnelCloseAction = "stop" | "slow-retry" | "backoff-retry";

export interface TunnelClosePlan {
  action: TunnelCloseAction;
  /** exit the process with this code after logging (a "stop" that is fatal) */
  exitCode?: number;
  /** what to print, or null to stay quiet (the caller owns the blip line) */
  message: string | null;
}

export interface TunnelCloseInput {
  code: number;
  /** the close frame's reason, as the server sent it (may be truncated) */
  reason: string;
  /** the protocol level THIS agent speaks, for the mismatch sentence */
  protocol: number;
  /** sessions still alive locally — a blip keeps them, a stop drops them */
  liveSessions: number;
  /** whether the 4403 explanation already printed this stretch */
  revokedNoted: boolean;
}

/**
 * Decide what a close code means. The caller still owns the side effects
 * (dispose local harnesses on stop, schedule the reconnect, exit).
 */
export function planTunnelClose({ code, reason, protocol, liveSessions, revokedNoted }: TunnelCloseInput): TunnelClosePlan {
  /* the host was deleted on the server: retrying can never succeed. Stop,
     and dispose local harnesses — nothing will ever ask about them again. */
  if (code === TUNNEL_CLOSE.HOST_DELETED) {
    return {
      action: "stop",
      message: `[node-agent] this host was deleted on the server; not retrying — re-add it (new id + token) and restart the agent`,
    };
  }

  /* protocol refusal (issue #217): the server does not speak our level (or
     could not read ours). Retrying re-runs the identical refusal forever and
     buries the one line that explains it, so print the mismatch and exit
     nonzero — the fix is a human reinstalling this agent or upgrading the
     server. */
  if (code === TUNNEL_CLOSE.PROTOCOL_TOO_NEW) {
    return {
      action: "stop",
      exitCode: 1,
      message:
        `[node-agent] the server refused this agent: ${reason || "protocol too new"}. ` +
        `This agent speaks tunnel protocol ${protocol}; the server does not. ` +
        "Update the Truss server, or install a matching agent bundle from the server you are dialing " +
        "(the add-host wizard's install command), then restart this agent. Not retrying.",
    };
  }

  /* revoked/rotated token: the user can fix it, so keep a slow watch rather
     than spamming a line they can't act on every 15s. Explains once. */
  if (code === TUNNEL_CLOSE.UNAUTHORIZED) {
    return {
      action: "slow-retry",
      message: revokedNoted
        ? "[node-agent] still refused (4403); next check in 60s"
        : "[node-agent] the server refuses this host's token (revoked or rotated) — fix it in the host panel " +
          "(rotate/enable), update ~/.truss/agent-*.env, restart the agent. Checking again every 60s.",
    };
  }

  /* everything else is a BLIP, not a death sentence (issue #100, item 7):
     harnesses keep running locally, their events buffer, and the next
     hello's session list reattaches them. A 1s flap no longer kills a
     running turn. */
  return {
    action: "backoff-retry",
    message: liveSessions
      ? `[node-agent] tunnel down — keeping ${liveSessions} session(s) alive locally until reconnect`
      : null,
  };
}
