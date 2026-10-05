/**
 * Dial failure guidance (issue #100). The agent's retry loop used to print
 * the raw syscall (`ws error: connect ECONNREFUSED 100.107.125.118:4040`)
 * forever — the user had to decode it themselves while the real cause was
 * almost always one of two: the server only listens on loopback, or the
 * tailnet path to it is dead.
 *
 * Pure builder: the retry loop counts consecutive connect failures and asks
 * here what (if anything) to say. Early attempts stay silent (a booting
 * server is normal); non-connect errors (auth closes, socket faults) have
 * their own voices and never get invented causes.
 */

export interface DialFailure {
  /** syscall/code from the ws error (ECONNREFUSED, ETIMEDOUT, …) */
  code: string;
  /** the server url the agent keeps failing to reach */
  url: string;
  /** consecutive failures so far (1-based) */
  attempts: number;
}

/* one or two failures are a booting/restarting server — saying anything
   would cry wolf; from the third on, the loop is real */
const QUIET_BELOW = 3;

export function dialFailureHint({ code, url, attempts }: DialFailure): string | null {
  if (attempts < QUIET_BELOW) return null;

  if (code === "ECONNREFUSED") {
    return (
      `the server is refusing connections at ${url} (ECONNREFUSED, attempt ${attempts}) — ` +
      `nothing is listening there. Most likely the Truss server is bound to loopback only: ` +
      `restart it with TRUSS_HOST=0.0.0.0 so it listens on the network, or turn on \`tailscale serve\` ` +
      `on the server (Settings → Network) and point this agent's TRUSS_SERVER at the serve URL ` +
      `(edit ~/.truss/agent-*.env, then restart the agent).`
    );
  }

  if (code === "ETIMEDOUT" || code === "EHOSTUNREACH" || code === "ENETUNREACH") {
    return (
      `reaching ${url} keeps timing out (${code}, attempt ${attempts}) — the network path is dead: ` +
      `the server may be offline, a firewall may be dropping the port, or the tailnet route is down ` +
      `(check \`tailscale status\` on both ends, or \`tailscale serve\` on the server). ` +
      `If the server moved, update TRUSS_SERVER in ~/.truss/agent-*.env and restart the agent.`
    );
  }

  /* anything else (auth closes, TLS faults, socket errors) already has its
     own message — never invent a cause */
  return null;
}
