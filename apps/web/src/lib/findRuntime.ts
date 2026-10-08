/**
 * The app-side machinery for app-native find (issue #194) — everything the
 * pure core (lib/findInPanel.ts) deliberately does not know: which panel is
 * focused, how a panel paints its matches, where the bar gets its target.
 *
 * A searchable panel (chat, terminal, feed, monitor) registers a
 * FindProvider keyed by (its workspace's dockview api, its panel id).
 * Cmd/Ctrl+F — wired in App.tsx — resolves the focused panel (the ACTIVE
 * workspace's active panel) and opens that panel's find bar; the bar drives
 * only that provider, so a query never leaks across panels.
 *
 * Two provider shapes:
 *
 *   domFindProvider — chat transcripts, feed, monitor. Marks are painted
 *   with the CSS Custom Highlight API, which draws WITHOUT touching the
 *   DOM: React never loses a text node to a wrapper <mark>, and a streamed
 *   token never fights the highlighter (a MutationObserver simply repaints).
 *   On engines without the API the marks skip silently; counting and
 *   scroll-to-match still work.
 *
 *   terminalFindProvider — xterm's own SearchAddon, which searches the
 *   whole scrollback buffer; the match count comes from a literal scan of
 *   the same buffer (findMatches over joinBufferLines) so the "n of N" the
 *   bar shows is the contract's semantics, not the addon's.
 */

import { useSyncExternalStore } from "react";
import type { Terminal } from "@xterm/xterm";
import type { ISearchOptions, SearchAddon } from "@xterm/addon-search";
import { desktops } from "./desktops";
import { store } from "./store";
import { cycleMatch, findMatches } from "./findInPanel";
import { joinBufferLines, locateOffset, type BufferLine } from "./findText";

/* ------------------------------------------------------------------ */
/* providers                                                           */
/* ------------------------------------------------------------------ */

/**
 * What a searchable panel offers the find bar. The provider owns its marks;
 * the bar owns the keystrokes. Counts are 0-based-position + total, matching
 * findMatches/cycleMatch.
 */
export interface FindProvider {
  /** Apply a query: paint every match, reveal the first; return the total. */
  setQuery(query: string): number;
  /** Move the current match one step (wraps); return the new position, -1 when none. */
  step(dir: 1 | -1): number;
  /** Remove every mark and stop watching for content changes. */
  clear(): void;
  /** Hand focus back to the panel content after the bar closes. */
  focus?(): void;
  /** The bar sets this while mounted: a repaint that changed the count pushes it here. */
  onRecount?: (count: number) => void;
}

const providers = new WeakMap<object, Map<string, FindProvider>>();

/**
 * A panel calls this on mount; the returned disposer runs on unmount.
 * Missing dockview context (a panel rendered outside a dock — the
 * server-render test harness passes {}) registers nothing: that panel is
 * simply not findable.
 */
export function registerFindProvider(dockApi: object | undefined, panelId: string | undefined, provider: FindProvider): () => void {
  if (!dockApi || !panelId) return () => {};
  let byPanel = providers.get(dockApi);
  if (!byPanel) {
    byPanel = new Map();
    providers.set(dockApi, byPanel);
  }
  byPanel.set(panelId, provider);
  return () => {
    const m = providers.get(dockApi);
    if (m?.get(panelId) === provider) m.delete(panelId);
  };
}

/** The provider registered for (dock api, panel id), if any — the exact lookup the chord makes. */
export function findProviderFor(dockApi: object | undefined, panelId: string | undefined): FindProvider | undefined {
  if (!dockApi || !panelId) return undefined;
  return providers.get(dockApi)?.get(panelId);
}

/* ------------------------------------------------------------------ */
/* the target: which panel the bar is open on                          */
/* ------------------------------------------------------------------ */

interface FindState {
  /** the (dock api, panel id) pair the bar is open on; null = closed */
  target: { api: object; panel: string } | null;
  /** bumps on every chord fire so an already-open bar re-selects its query */
  nonce: number;
}

let findState: FindState = { target: null, nonce: 0 };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

export function closeFind(): void {
  if (!findState.target) return;
  findState = { ...findState, target: null };
  emit();
}

/**
 * The Cmd/Ctrl+F handler (App.tsx). Intercepts unconditionally — the
 * browser's find can only misfire over dockview — then opens the focused
 * panel's bar, or explains why there is nothing to search.
 */
export function openFindInActivePanel(): void {
  const api = desktops.getApi();
  const panel = api?.activePanel;
  if (!api || !panel) return; // an empty workspace has nothing to search
  if (!findProviderFor(api, panel.id)) {
    store.toast("info", "Nothing to search in this panel", "Find searches chat transcripts, shell output, the feed, and the monitor.");
    return;
  }
  findState = { target: { api, panel: panel.id }, nonce: findState.nonce + 1 };
  emit();
}

const getFindState = () => findState;
const subscribeFind = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

/** A panel asks: is the find bar open on ME? (plus the re-fire nonce). Undefined context = never open. */
export function useFindOpen(dockApi: object | undefined, panelId: string | undefined): { open: boolean; nonce: number } {
  const s = useSyncExternalStore(subscribeFind, getFindState, getFindState);
  return { open: !!dockApi && !!panelId && s.target?.api === dockApi && s.target?.panel === panelId, nonce: s.nonce };
}

/* ------------------------------------------------------------------ */
/* the DOM provider (chat, feed, monitor)                              */
/* ------------------------------------------------------------------ */

/* The highlight names are FIXED and the CSS lives in index.css: at most one
   find bar is open at a time (the target is a single slot), so at most one
   DOM provider is painting. livePainter guards the tail of that invariant —
   a slow unmount cleanup may run after the next bar already painted, and it
   must not wipe the new owner's marks. */
const HL_ALL = "truss-find";
const HL_CURRENT = "truss-find-current";
let livePainter: object | null = null;

const highlightsOK = () => typeof CSS !== "undefined" && "highlights" in CSS;

function textMap(root: HTMLElement): { nodes: Text[]; starts: number[]; lengths: number[]; text: string } {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  const starts: number[] = [];
  const lengths: number[] = [];
  let text = "";
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    const v = t.nodeValue ?? "";
    if (!v) continue; // empty nodes would need zero-length entries in starts/lengths
    starts.push(text.length);
    nodes.push(t);
    lengths.push(v.length);
    text += v;
  }
  return { nodes, starts, lengths, text };
}

/**
 * A FindProvider over a panel's DOM subtree (the scroll element). `root` is
 * read lazily on every operation — panels re-render freely, the ref target
 * is what stays stable.
 */
export function domFindProvider(root: () => HTMLElement | null): FindProvider {
  const self: FindProvider = { setQuery, step, clear };
  let query = "";
  let ranges: Range[] = [];
  let current = -1;
  let observer: MutationObserver | null = null;
  let raf = 0;

  const clearMarks = () => {
    ranges = [];
    current = -1;
    if (highlightsOK() && livePainter === self) {
      CSS.highlights.delete(HL_ALL);
      CSS.highlights.delete(HL_CURRENT);
      livePainter = null;
    }
  };

  /** Rebuild ranges from the live DOM and paint; keeps `current` in range. */
  const paint = (): number => {
    const el = root();
    if (!el || !query.trim()) {
      clearMarks();
      return 0;
    }
    const { nodes, starts, lengths, text } = textMap(el);
    const matches = findMatches(text, query);
    ranges = [];
    for (const m of matches) {
      const a = locateOffset(starts, lengths, m.index);
      const b = locateOffset(starts, lengths, m.index + m.length);
      if (!a || !b) continue; // cannot happen for offsets findMatches just returned
      const r = el.ownerDocument.createRange();
      r.setStart(nodes[a.fragment], a.offset);
      r.setEnd(nodes[b.fragment], b.offset);
      ranges.push(r);
    }
    current = ranges.length ? Math.min(Math.max(current, 0), ranges.length - 1) : -1;
    if (highlightsOK()) {
      CSS.highlights.set(HL_ALL, new Highlight(...ranges));
      livePainter = self;
      if (current >= 0) paintCurrent();
      else CSS.highlights.delete(HL_CURRENT);
    }
    return ranges.length;
  };

  /* The current match paints ABOVE the rest: later insertion in the
     HighlightRegistry wins, and the explicit priority keeps it true even
     after a live repaint re-sets the "all" entry. */
  const paintCurrent = () => {
    const hl = new Highlight(ranges[current]);
    (hl as { priority?: number }).priority = 1;
    CSS.highlights.set(HL_CURRENT, hl);
  };

  const reveal = (i: number): number => {
    if (!ranges.length) return -1;
    current = ((i % ranges.length) + ranges.length) % ranges.length;
    if (highlightsOK()) paintCurrent();
    const node = ranges[current].startContainer;
    (node.nodeType === 1 ? (node as Element) : node.parentElement)?.scrollIntoView({ block: "center", inline: "nearest" });
    return current;
  };

  /* Streamed tokens and polling panels mutate the subtree under an open
     bar; one paint per frame is plenty, and painting never feeds back into
     the observer because the Highlight API touches no DOM. */
  const scheduleRepaint = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const before = ranges.length;
      const count = paint();
      if (count !== before) self.onRecount?.(count);
    });
  };

  const watch = () => {
    const el = root();
    if (!el || observer) return;
    observer = new MutationObserver(scheduleRepaint);
    observer.observe(el, { subtree: true, childList: true, characterData: true });
  };

  function setQuery(q: string): number {
    query = q;
    const count = paint();
    if (!q.trim()) {
      /* a blanked query stops watching too — the observer would repaint
         nothing on every mutation */
      observer?.disconnect();
      observer = null;
      return 0;
    }
    /* watch even at 0 matches: a transcript streams, and a match that does
       not exist yet can arrive a second later (audit B2) */
    watch();
    if (count) reveal(0);
    return count;
  }

  function step(dir: 1 | -1): number {
    if (!ranges.length) return -1;
    return reveal(cycleMatch(current, ranges.length, dir));
  }

  function clear(): void {
    query = "";
    observer?.disconnect();
    observer = null;
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    clearMarks();
  }

  return self;
}

/* ------------------------------------------------------------------ */
/* the terminal provider (xterm SearchAddon)                           */
/* ------------------------------------------------------------------ */

/* The amber family of the terminal theme (TerminalPanel THEME.selection):
   every match a translucent wash, the current one solid. */
const TERM_FIND_OPTIONS: ISearchOptions = {
  caseSensitive: false,
  regex: false,
  decorations: {
    matchBackground: "#f0b35a59",
    matchOverviewRuler: "#f0b35a99",
    activeMatchBackground: "#f0b35ad9",
    activeMatchColorOverviewRuler: "#f0b35a",
  },
};

/** The contract's count for a terminal: literal matches over the joined buffer (scrollback included). */
export function terminalMatchCount(term: Terminal, query: string): number {
  const buf = term.buffer.active;
  const lines: BufferLine[] = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    lines.push({ text: line?.translateToString(true) ?? "", wrapped: line?.isWrapped ?? false });
  }
  return findMatches(joinBufferLines(lines), query).length;
}

/**
 * A FindProvider over an xterm instance. Highlighting, scrolling, and
 * wrap-around next/prev are the SearchAddon's own; this provider keeps the
 * query and the display position. `get` is read lazily: the terminal is
 * (re)created on attach/font changes while the provider lives on.
 */
export function terminalFindProvider(get: () => { term: Terminal; search: SearchAddon } | null): FindProvider {
  let query = "";
  let count = 0;
  let current = -1;
  /* shells stream under an open bar: the SearchAddon re-scans a live buffer
     it has decorations on and reports the fresh total, which keeps "n / N"
     honest (audit B2). The subscription follows the CURRENT addon instance
     — a reattach/font rebuild replaces it (termRef in TerminalPanel) */
  let subscribedTo: SearchAddon | null = null;
  let resultsSub: { dispose(): void } | null = null;
  const unwatch = () => {
    resultsSub?.dispose();
    resultsSub = null;
    subscribedTo = null;
  };

  const self: FindProvider = {
    setQuery(q) {
      query = q;
      const t = get();
      if (!t || !q.trim()) {
        unwatch();
        t?.search.clearDecorations();
        t?.search.clearActiveDecoration();
        count = 0;
        current = -1;
        return 0;
      }
      count = terminalMatchCount(t.term, q);
      if (subscribedTo !== t.search) {
        unwatch();
        subscribedTo = t.search;
        resultsSub = t.search.onDidChangeResults((e) => {
          if (!query || e.resultCount <= 0 || e.resultCount === count) return;
          count = e.resultCount;
          self.onRecount?.(count);
        });
      }
      /* jump to the nearest match as the query is typed, browser-style; the
         addon paints every match when decorations ride along */
      current = t.search.findNext(q, TERM_FIND_OPTIONS) ? 0 : -1;
      return count;
    },
    step(dir) {
      const t = get();
      if (!t || !count || !query.trim()) return current;
      const hit = dir === 1 ? t.search.findNext(query, TERM_FIND_OPTIONS) : t.search.findPrevious(query, TERM_FIND_OPTIONS);
      if (hit) current = cycleMatch(current, count, dir);
      return current;
    },
    clear() {
      unwatch();
      const t = get();
      t?.search.clearDecorations();
      t?.search.clearActiveDecoration();
      query = "";
      count = 0;
      current = -1;
    },
    focus() {
      get()?.term.focus();
    },
  };
  return self;
}
