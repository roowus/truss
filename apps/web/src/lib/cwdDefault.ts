/**
 * The one named precedence for the New Session dialog's default working
 * directory (issue #106). Before this helper the default was an inline
 * `preset || settings || recent` chain in the dialog, and the per-host
 * default (HostPreference.defaultCwd, set for remote boxes in the Hosts
 * panel) never won.
 *
 * Order: an explicit preset (task board, "new session here") beats
 * everything; then the picked host's own default; then the global Settings
 * default; then the most recent session's cwd; else blank. Blank or
 * whitespace-only candidates never win — they fall through.
 */
export interface CwdDefaultInput {
  preset?: string;
  hostDefault?: string;
  settingsDefault?: string;
  recent?: string;
}

export function resolveDefaultCwd(input: CwdDefaultInput): string {
  for (const candidate of [input.preset, input.hostDefault, input.settingsDefault, input.recent]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

/* ── the picked host's default, for the hostDefault candidate ── */

/** Structural minimums so this helper stays pure (no store/proto imports). */
export interface HostPrefLike {
  defaultCwd?: string;
}
export interface HostLike {
  id: string;
  agent?: { hostname?: string };
}

/**
 * The harness id's "@host" suffix keys the per-host preference. Server-side
 * the suffix IS the host id (`${adapterId}@${hostId}`, remote.ts), so the
 * direct hit is the real path; the registry walk covers suffixes that are a
 * hostname or short hostname instead of the host id.
 */
export function hostDefaultFor(harnessId: string, prefs: Record<string, HostPrefLike>, hosts: HostLike[] = []): string {
  const at = harnessId.indexOf("@");
  if (at < 0) return "";
  const suffix = harnessId.slice(at + 1);
  if (!suffix) return "";
  const direct = prefs[suffix]?.defaultCwd;
  if (direct) return direct;
  const host = hosts.find((h) => h.id === suffix || h.agent?.hostname === suffix || h.agent?.hostname?.split(".")[0] === suffix);
  return (host && prefs[host.id]?.defaultCwd) || "";
}
