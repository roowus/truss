/**
 * The add-host one-liner, shell-safe (issue #22): the bare URL's `?` is a
 * glob metacharacter — zsh (macOS default) aborts with "no matches found"
 * before curl even starts. The URL is single-quote wrapped with POSIX-style
 * escaping; the rest of the line carries no unquoted metacharacters.
 */

/** POSIX single-quote: 'it'\''s' — safe for any content */
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function buildInstallCommand(serverAddr: string, hostId: string, token: string): string {
  return `curl -fsSL ${shq(`${serverAddr}/agent/install.sh?host=${hostId}`)} | sh -s -- ${token}`;
}

/**
 * How to START the agent by hand (no systemd on the remote — macOS): the
 * installer only lays the files down there. Shared by the add-host wizard's
 * waiting step and the host panel's offline banner so the two never drift.
 */
export function agentRunCommand(hostId: string): string {
  return `set -a; . ~/.truss/agent-${hostId}.env; set +a; node ~/.truss/node-agent.mjs`;
}
