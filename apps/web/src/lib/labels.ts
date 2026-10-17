/* GitHub-style session labels (issue #174): the display side. The server
   owns cleaning and persistence (POST /api/sessions/:id/labels); this
   module owns how a label LOOKS (a deterministic auto-color, so the same
   name is the same color on every render and every client) and how many
   chips a crowded row shows. */

/* mirrors the server's SESSION_LABEL_CAP (apps/server/src/sessions.ts).
   Web carries no dependency on @truss/proto/the server package, so the
   constant is duplicated deliberately — one web-side definition shared by
   the header's disable-at-cap and the demo's cleaning mirror */
export const SESSION_LABEL_CAP = 8;

/* FNV-1a over the lowercased name — stable across renders, clients, and
   casing ("Research" and "research" are one label, one color) */
function labelHash(name: string): number {
  let h = 0x811c9dc5;
  const s = name.trim().toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/* hand-tuned against the dark theme: readable as a small dot or chip tint,
   spread apart so neighbors in the palette never clash. The first six are
   the theme's own accent hues; the rest extend the same family. Twelve
   slots keep common label vocabularies collision-light (hashed mod 12). */
const PALETTE = [
  "#f0b35a", // amber
  "#5fc9c0", // teal
  "#a99bf0", // violet
  "#6fa8e8", // sky
  "#ec7f5c", // coral
  "#8fd07f", // green
  "#e87fb0", // pink
  "#d8c568", // straw
  "#7fb8d0", // steel
  "#c09568", // clay
  "#9bd6a0", // sage
  "#e89a7d", // apricot
];

/** deterministic palette color per label name (case-insensitive identity);
    garbage-safe — "" hashes like anything else and still lands on a color */
export function labelColor(name: string): string {
  return PALETTE[labelHash(name) % PALETTE.length];
}

/** a row's chip window: the first `maxVisible` labels render, the rest
    collapse into an honest "+k" — never more than the cap on screen */
export function labelChips(labels: string[], maxVisible = 3): { shown: string[]; overflow: number } {
  const shown = labels.slice(0, Math.max(0, maxVisible));
  return { shown, overflow: labels.length - shown.length };
}

/** the sidebar filter's match: case-insensitive membership (the server's
    dedupe is case-insensitive too, so the filter never splits one label
    into two spellings); no active filter matches everything */
export function sessionHasLabel(labels: string[] | undefined, active: string | null): boolean {
  const key = (active ?? "").trim().toLowerCase();
  if (!key) return true;
  return (labels ?? []).some((l) => l.toLowerCase() === key);
}

/** demo-mode mirror of the server's cleaning (trim, 32-char cap, blanks
    dropped, case-insensitive dedupe keeping first casing, 8 max). The live
    server is authoritative — this keeps the in-browser demo honest without
    a round-trip. */
export function cleanLabelNames(input: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const name = raw.trim().slice(0, 32);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= SESSION_LABEL_CAP) break;
  }
  return out;
}
