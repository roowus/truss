/**
 * The settings page table of contents (issue #211). ONE list of sections is
 * the source of truth for the page: SettingsPanel renders its section
 * anchors from it and the TOC rail links it. The scroll-spy rule is the
 * turn rail's (#7): the current section is the last one whose anchor top is
 * at/above the read line.
 */

export interface SettingsSection {
  /** stable kebab id, also the anchor the rail links to */
  id: string;
  /** rail label */
  label: string;
}

export interface SectionAnchor {
  id: string;
  /** px from the top of the scroll content */
  top: number;
}

/** the page's seven sections, in page order */
export function settingsSections(): SettingsSection[] {
  return [
    { id: "appearance", label: "Appearance" },
    { id: "sessions", label: "Sessions" },
    { id: "workspaces", label: "Workspaces" },
    { id: "feed", label: "Feed" },
    { id: "integrations", label: "Integrations" },
    { id: "network", label: "Network" },
    { id: "practices", label: "Practices" },
  ];
}

/** scroll-spy: the LAST section whose anchor is at/above the read line;
    above the first → the first; an empty anchor list → "" (never throws). */
export function activeSectionId(readLine: number, anchors: SectionAnchor[]): string {
  if (anchors.length === 0) return "";
  let active = anchors[0].id;
  for (const a of anchors) {
    if (a.top <= readLine) active = a.id;
  }
  return active;
}

export interface RailEntry extends SettingsSection {
  /** false when the section's anchor isn't in the page (Network/Practices
      mount late, and a failed fetch keeps Network away for good) — the rail
      disables the entry instead of offering a click that silently no-ops */
  enabled: boolean;
}

/** the rail's rows: the shared list joined with the section ids actually
    present in the page, order preserved */
export function railEntries(presentIds: string[]): RailEntry[] {
  const present = new Set(presentIds);
  return settingsSections().map((s) => ({ ...s, enabled: present.has(s.id) }));
}
