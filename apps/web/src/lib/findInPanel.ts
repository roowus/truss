/**
 * App-native find (issue #194): the pure core. Cmd/Ctrl+F opens a find bar
 * scoped to the FOCUSED dockview panel — the browser's own find can't scope
 * to one panel or drive a transcript, so the app intercepts the chord and
 * the browser find never opens over a dockview surface.
 *
 * This module stays DOM-free so the contract tests run under bare node.
 * Everything that touches the DOM (text-node mapping, CSS highlights) or
 * xterm (the SearchAddon) lives in lib/findRuntime.ts; the offset/buffer
 * math both share lives in lib/findText.ts.
 */

export interface FindMatch {
  index: number;
  length: number;
}

/**
 * Every occurrence of `query` in `text`, case-insensitive and LITERAL — a
 * query like "a.*b" is text, never a regex. Blank (empty or whitespace-only)
 * queries match nothing; neither does empty text. Matches never overlap
 * (like every editor's find): after a hit the scan resumes past it. Never
 * throws — chat transcripts run to hundreds of thousands of characters.
 *
 * Case folding lowercases both sides, so an exotic fold that changes string
 * length (Turkish İ) could skew a position — the same tradeoff browser find
 * makes, and invisible in practice.
 */
export function findMatches(text: string, query: string): FindMatch[] {
  if (!text || !query.trim()) return [];
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  const out: FindMatch[] = [];
  let from = 0;
  for (;;) {
    const hit = hay.indexOf(needle, from);
    if (hit < 0) return out;
    out.push({ index: hit, length: needle.length });
    from = hit + needle.length;
  }
}

/**
 * Enter / Shift+Enter: the position one step from `current`, wrapping at
 * both ends. No matches → -1 (there is no position to be on).
 */
export function cycleMatch(current: number, total: number, dir: 1 | -1): number {
  if (total <= 0) return -1;
  return (((current + dir) % total) + total) % total;
}

export interface FindChordEvent {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

/**
 * Exactly Cmd/Ctrl+F. A plain f is typing; the Shift form stays free for a
 * future workspace-wide find; Alt forms belong to other gestures (and AltGr
 * is typing, not a chord).
 */
export function isFindChord(e: FindChordEvent): boolean {
  return (e.metaKey === true || e.ctrlKey === true) && e.shiftKey !== true && e.altKey !== true && e.key.toLowerCase() === "f";
}
