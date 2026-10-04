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
