/**
 * The one named precedence for the New Session dialog's default working
 * directory (issue #106). Before this helper the default was an inline
 * `preset || settings || recent` chain in the dialog, and the per-host
 * default (HostPreference.defaultCwd, set for remote boxes in the Hosts
 * panel) never won.
 *
 * Order: an explicit preset (task board, "new session here") beats
 * everything; then the picked host's own default; then the host's OWN
 * suggestion (issue #123 — the remote announces its home + existing
 * projects-family dirs at hello, so a remote pick prefills a directory that
 * exists THERE, not this machine's idea of one); then the global Settings
 * default; then the most recent session's cwd; else blank. Blank or
 * whitespace-only candidates never win — they fall through.
 */
export interface CwdDefaultInput {
  preset?: string;
  hostDefault?: string;
  hostSuggested?: string;
  settingsDefault?: string;
  recent?: string;
}

export function resolveDefaultCwd(input: CwdDefaultInput): string {
  for (const candidate of [input.preset, input.hostDefault, input.hostSuggested, input.settingsDefault, input.recent]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

/* ── the picked host's record, shared by the hostDefault/hostSuggested
     candidates (audit round 3, B2: the resolution rule must exist ONCE —
     two copies would silently diverge, and the pref would resolve while
     the suggestion didn't, or vice versa) ── */

/** Structural minimums so this helper stays pure (no store/proto imports). */
export interface HostPrefLike {
  defaultCwd?: string;
}
export interface HostLike {
  id: string;
  agent?: { hostname?: string; suggestedCwd?: string };
}

/** the "@host" suffix of a harness id; "" for local harnesses */
function hostSuffix(harnessId: string): string {
  const at = harnessId.indexOf("@");
  return at < 0 ? "" : harnessId.slice(at + 1);
}

/**
 * Resolve a harness-id suffix to its host record. Server-side the suffix IS
 * the host id (`${adapterId}@${hostId}`, remote.ts), so the direct hit is
 * the real path; the full/short hostname forms cover suffixes that are a
 * hostname instead of the host id.
 */
function hostFor(suffix: string, hosts: HostLike[]): HostLike | undefined {
  return hosts.find((h) => h.id === suffix || h.agent?.hostname === suffix || h.agent?.hostname?.split(".")[0] === suffix);
}

/** the picked host's default, for the hostDefault candidate */
export function hostDefaultFor(harnessId: string, prefs: Record<string, HostPrefLike>, hosts: HostLike[] = []): string {
  const suffix = hostSuffix(harnessId);
  if (!suffix) return "";
  const direct = prefs[suffix]?.defaultCwd;
  if (direct) return direct;
  const host = hostFor(suffix, hosts);
  return (host && prefs[host.id]?.defaultCwd) || "";
}

/**
 * The picked host's OWN suggestion (issue #123): what the remote's agent
 * announced at hello (a projects-family dir when one exists there, else its
 * home). Same suffix resolution as hostDefaultFor (shared hostFor above);
 * "" for local harnesses, unknown hosts, and pre-discovery agents (which
 * carry no suggestion — the chain then falls through to this machine's
 * defaults, today's behavior).
 */
export function hostSuggestedFor(harnessId: string, hosts: HostLike[] = []): string {
  const suffix = hostSuffix(harnessId);
  if (!suffix) return "";
  return hostFor(suffix, hosts)?.agent?.suggestedCwd ?? "";
}
