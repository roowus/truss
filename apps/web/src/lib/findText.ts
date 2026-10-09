/**
 * The shared offset math behind app-native find (issue #194). Both provider
 * shapes in lib/findRuntime.ts flatten their panel's text into one string,
 * run findMatches (lib/findInPanel.ts) over it, and then need these two
 * mappings back. Pure and DOM-free so the pins in test/findText.test.ts run
 * under bare node.
 */

/**
 * Where a character offset in a joined text lives: which fragment (a text
 * node for the DOM provider, a buffer line for the terminal) and the offset
 * inside it. `starts[i]` is fragment i's first character in the joined text,
 * `lengths[i]` its length. An index one PAST a fragment's last character is
 * still that fragment (a Range end position); anything further is out of
 * bounds → null.
 */
export function locateOffset(starts: number[], lengths: number[], index: number): { fragment: number; offset: number } | null {
  if (index < 0 || !starts.length) return null;
  /* last fragment whose start is at or before the index */
  let lo = 0;
  let hi = starts.length - 1;
  let frag = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= index) {
      frag = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (frag < 0 || index > starts[frag] + lengths[frag]) return null;
  return { fragment: frag, offset: index - starts[frag] };
}

export interface BufferLine {
  text: string;
  /** xterm semantics: true when this line CONTINUES the previous one. */
  wrapped: boolean;
}

/**
 * Join terminal buffer lines into searchable text. A wrapped line continues
 * its predecessor with NO separator (a long command soft-wrapped by the
 * terminal is one logical line, and xterm's own search sees it the same
 * way); a hard line break joins with "\n" — which a single-line find query
 * can never match across, so matches never straddle real rows.
 */
export function joinBufferLines(lines: BufferLine[]): string {
  let out = "";
  for (let i = 0; i < lines.length; i++) {
    out += lines[i].text;
    if (i + 1 < lines.length && !lines[i + 1].wrapped) out += "\n";
  }
  return out;
}
