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
