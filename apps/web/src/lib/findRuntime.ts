/**
 * The app-side machinery for app-native find (issue #194; the scope picker
 * is the developer's review feedback on PR #210, given in the working
 * session) — everything the pure core
 * (lib/findInPanel.ts) deliberately does not know: which panel is focused,
 * how a panel paints its matches, and how a search spans panels and
 * workspaces.
 *
 * EVERY panel is searchable. Workspace wraps each panel component in one
 * generic DOM provider keyed by (dock api, panel id); terminals opt out of
 * the wrapper and register an xterm SearchAddon provider instead — the DOM
 * only holds the visible rows, the addon searches the whole buffer.
 *
 * The bar is global (one row under the desktop strip) with a scope picker:
 * this panel, this workspace's panels, or every workspace's panels.
 * Enter/Shift+Enter cycle the whole scope — running off one panel's end
 * jumps to the next panel with matches (activating its tab, switching to
 * its workspace when needed) and wraps around the scope.
 *
 * Two provider shapes:
 *
 *   domFindProvider — everything rendered as DOM. Marks are painted with
 *   the CSS Custom Highlight API, which draws WITHOUT touching the DOM:
 *   React never loses a text node to a wrapper <mark>, and a streamed token
 *   never fights the highlighter (a MutationObserver simply repaints). On
 *   engines without the API the marks skip silently; counting and
 *   scroll-to-match still work.
 *
 *   terminalFindProvider — xterm's own SearchAddon, which searches the
 *   whole scrollback buffer; the match count comes from a literal scan of
 *   the same buffer (findMatches over joinBufferLines) so the "n / N" the
 *   bar shows is the contract's semantics, not the addon's.
 */

import { useCallback, useRef, useSyncExternalStore } from "react";
import type { DockviewApi } from "dockview-react";
import type { Terminal } from "@xterm/xterm";
import type { ISearchOptions, SearchAddon } from "@xterm/addon-search";
import { desktops } from "./desktops";
import { cycleMatch, findMatches } from "./findInPanel";
import { joinBufferLines, locateOffset, type BufferLine } from "./findText";

/* ------------------------------------------------------------------ */
/* providers                                                           */
/* ------------------------------------------------------------------ */

/**
 * What a searchable panel offers the find controller. The controller owns
 * the query, the scope, and the current position; providers own the marks.
 * Positions are absolute 0-based indices into the provider's own matches.
 */
export interface FindProvider {
  /** Apply a query: paint every match (no current yet); return the total. */
  setQuery(query: string): number;
  /** Make `index` the current match and scroll to it; return the index used (-1 when none). */
  reveal(index: number): number;
  /** Drop just the current mark (another panel took over cycling). */
  clearCurrent(): void;
  /** Remove every mark and stop watching for content changes. */
  clear(): void;
  /** The panel unmounted — release everything (clear + the provider's style element). */
  dispose?(): void;
  /** Hand focus back to the panel content after the bar closes. */
  focus?(): void;
  /** True when the panel is on screen — hidden tabs/workspaces get activated before a reveal. */
  isVisible(): boolean;
  /** A live repaint pushed a fresh total (and position, when the provider tracks one). */
  onRecount?: (count: number, current?: number) => void;
}

const providers = new WeakMap<object, Map<string, FindProvider>>();

/**
 * A panel registers on mount; the returned disposer runs on unmount.
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
    if (m?.get(panelId) === provider) {
      m.delete(panelId);
      provider.dispose?.();
    }
  };
}

/** The provider registered for (dock api, panel id), if any. */
export function findProviderFor(dockApi: object | undefined, panelId: string | undefined): FindProvider | undefined {
  if (!dockApi || !panelId) return undefined;
  return providers.get(dockApi)?.get(panelId);
}

/* ------------------------------------------------------------------ */
/* scope math (pure — pinned in test/findRuntime.test.ts)              */
/* ------------------------------------------------------------------ */

export type FindScope = "panel" | "space" | "all";

export interface FindEntrySpec {
  api: object;
  panel: string;
}

/** What the collector needs from the app; injected so the pins stay DOM-free. */
export interface FindScopeSource {
  /** panel ids in the workspace's own (dockview) order */
  panelIds(api: object): string[];
  /** live workspaces in order, with their dock apis */
  spaces(): { api: object }[];
}

/**
 * Which (api, panel) pairs a scope searches, in stable cycle order: the
 * anchor alone; the anchor's workspace in tab order; or every live
 * workspace in order. Pairs without a registered provider are skipped.
 */
export function scopeEntries(scope: FindScope, anchor: FindEntrySpec, src: FindScopeSource, has: (api: object, panel: string) => boolean): FindEntrySpec[] {
  if (scope === "panel") return has(anchor.api, anchor.panel) ? [anchor] : [];
  const out: FindEntrySpec[] = [];
  const apis = scope === "space" ? [anchor.api] : src.spaces().map((s) => s.api);
  for (const api of apis) {
    for (const panel of src.panelIds(api)) {
      if (has(api, panel)) out.push({ api, panel });
    }
  }
  return out;
}

export interface FindEntryPos {
  count: number;
  current: number;
}

/**
 * One Enter/Shift+Enter step across a scope's entries. Within the active
 * entry it moves one match; at an entry's end it CROSSES to the next
 * match-bearing entry (wrapping around the scope); with a single
 * match-bearing entry it wraps inside it. Returns entry -1 when nothing
 * matches anywhere.
 */
export function stepEntries(entries: FindEntryPos[], active: number, dir: 1 | -1): { entry: number; index: number; crossed: boolean } {
  const bearing = entries.reduce((n, e) => n + (e.count > 0 ? 1 : 0), 0);
  if (!bearing) return { entry: -1, index: -1, crossed: false };
  const e = active >= 0 ? entries[active] : undefined;
  if (!e || e.count <= 0 || e.current < 0) {
    /* no current position yet: enter the first (or last) match-bearing entry */
    let j = -1;
    for (let s = 0; s < entries.length; s++) {
      const k = dir === 1 ? s : entries.length - 1 - s;
      if (entries[k].count > 0) {
        j = k;
        break;
      }
    }
    return { entry: j, index: dir === 1 ? 0 : entries[j].count - 1, crossed: true };
  }
  const atEnd = dir === 1 ? e.current >= e.count - 1 : e.current <= 0;
  if (!atEnd) return { entry: active, index: e.current + dir, crossed: false };
  if (bearing === 1) return { entry: active, index: cycleMatch(e.current, e.count, dir), crossed: false };
  let j = active;
  for (let s = 0; s < entries.length; s++) {
    j = (j + dir + entries.length) % entries.length;
    if (entries[j].count > 0) break;
  }
  return { entry: j, index: dir === 1 ? 0 : entries[j].count - 1, crossed: true };
}

/* ------------------------------------------------------------------ */
/* the find state + controller                                         */
/* ------------------------------------------------------------------ */

interface FindSnapshot {
  open: boolean;
  scope: FindScope;
  /** bumps on every chord fire so an open bar re-selects its query */
  nonce: number;
  query: string;
  total: number;
  /** 0-based position across the scope's matches; -1 = no current match */
  pos: number;
  /** the panel the chord was fired on — the panel scope's subject */
  anchor: FindEntrySpec | null;
}

interface FindEntry extends FindEntrySpec {
  provider: FindProvider;
  count: number;
  current: number;
}

let snap: FindSnapshot = { open: false, scope: "panel", nonce: 0, query: "", total: 0, pos: -1, anchor: null };
let entries: FindEntry[] = [];
let activeEntry = -1;

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());
const set = (patch: Partial<FindSnapshot>) => {
  snap = { ...snap, ...patch };
  emit();
};
const subscribeFind = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

/** The bar (and Workspace) read find state through this. */
export function useFindState<T>(selector: (s: FindSnapshot) => T): T {
  const ref = useRef(selector);
  ref.current = selector;
  const get = useCallback(() => ref.current(snap), []);
  return useSyncExternalStore(subscribeFind, get, get);
}

const prodSource: FindScopeSource = {
  panelIds: (api) => ((api as DockviewApi).panels ?? []).map((p) => p.id),
  spaces: () =>
    desktops.state.spaces
      .filter((s) => !s.archived)
      .map((s) => ({ api: desktops.getApi(s.id) }))
      .filter((s): s is { api: DockviewApi } => !!s.api),
};

/* read-only debug surface (store.ts exposes window.__truss the same way) —
   the controller's state is otherwise invisible to a browser smoke */
if (typeof window !== "undefined") {
  (window as unknown as { __trussFind?: unknown }).__trussFind = {
    state: () => snap,
    entries: () =>
      entries.map((e, i) => ({
        i,
        panel: e.panel,
        count: e.count,
        current: e.current,
        visible: e.provider.isVisible(),
        active: i === activeEntry,
      })),
  };
}

/**
 * Rebuild the entry list for the current scope. Providers that fell out of
 * scope (a narrower scope, a closed panel) get their marks wiped; surviving
 * entries keep their state.
 */
function collectEntries(): void {
  if (!snap.anchor) {
    entries = [];
    activeEntry = -1;
    return;
  }
  const specs = scopeEntries(snap.scope, snap.anchor, prodSource, (a, p) => !!findProviderFor(a, p));
  const next: FindEntry[] = [];
  for (const spec of specs) {
    const keep = entries.find((e) => e.api === spec.api && e.panel === spec.panel);
    if (keep) next.push(keep);
    else next.push({ ...spec, provider: findProviderFor(spec.api, spec.panel)!, count: 0, current: -1 });
  }
  for (const e of entries) {
    if (!next.includes(e)) {
      e.provider.onRecount = undefined;
      e.provider.clear();
    }
  }
  entries = next;
  if (activeEntry >= entries.length) activeEntry = -1;
}

function refreshTotals(): void {
  const total = entries.reduce((n, e) => n + e.count, 0);
  let pos = -1;
  if (activeEntry >= 0 && entries[activeEntry]?.current >= 0) {
    pos = entries.slice(0, activeEntry).reduce((n, e) => n + e.count, 0) + entries[activeEntry].current;
  }
  set({ total, pos });
}

/* set while the find controller activates a tab/workspace (a synchronous
   window around the activation calls — dockview emits onDidActiveChange
   synchronously inside setActive) */
let navDepth = 0;
export const isFindNavigating = () => navDepth > 0;

/** Bring an entry's panel on screen (workspace switch, tab activate), then run `after` post-paint. */
function activateEntry(e: FindEntry, after: () => void): void {
  /* panels that focus themselves when their tab activates (the terminal
     focuses xterm so a click lets you type) must not grab the keyboard from
     the find input when the ACTIVATION came from find navigation */
  navDepth++;
  try {
    const space = desktops.state.spaces.find((s) => desktops.getApi(s.id) === e.api);
    if (space && desktops.state.activeId !== space.id) desktops.switchTo(space.id);
    const api = e.api as DockviewApi;
    const panel = api.getPanel?.(e.panel);
    if (panel && api.activePanel?.id !== e.panel) panel.api.setActive();
  } finally {
    queueMicrotask(() => navDepth--);
  }
  /* the workspace/tab flip renders asynchronously — reveal after it paints */
  requestAnimationFrame(() => requestAnimationFrame(after));
}

/** (Re)run the current query across the current scope. */
function applyQuery(): void {
  collectEntries();
  const q = snap.query;
  for (const e of entries) {
    e.count = e.provider.setQuery(q);
    e.current = -1;
    e.provider.onRecount = (count, current) => {
      e.count = count;
      if (current !== undefined) e.current = current;
      refreshTotals();
    };
  }
  activeEntry = -1;
  if (q.trim()) {
    /* the anchor panel leads when it has matches — you searched FROM there */
    let ai = entries.findIndex((e) => e.count > 0 && snap.anchor && e.api === snap.anchor.api && e.panel === snap.anchor.panel);
    if (ai < 0) ai = entries.findIndex((e) => e.count > 0);
    if (ai >= 0) {
      activeEntry = ai;
      const e = entries[ai];
      /* typing marks and counts; it NAVIGATES only within what's already on
         screen (audit round 2, B2 — Chrome/VS Code reveal on Enter, not on
         keystrokes). A leading match in a hidden tab or another workspace
         waits for Enter/Shift+Enter, which crosses via findStep. */
      if (e.provider.isVisible()) {
        e.current = e.provider.reveal(0);
      }
    }
  }
  refreshTotals();
}

/**
 * The Cmd/Ctrl+F handler (App.tsx). Intercepted unconditionally up there —
 * the browser's find can only misfire over dockview. Anchors on the focused
 * panel (the ACTIVE workspace's active panel). Every panel is searchable
 * (the developer's PR #210 review feedback), so there is no "nothing to search" toast anymore — an
 * empty workspace is the only no-op.
 */
export function openFindInActivePanel(): void {
  const api = desktops.getApi();
  const panel = api?.activePanel;
  if (!api || !panel) return;
  set({ open: true, anchor: { api, panel: panel.id }, nonce: snap.nonce + 1 });
  applyQuery();
}

export function closeFind(): void {
  if (!snap.open) return;
  if (queryRaf) {
    /* a coalesced applyQuery must not re-mark after close */
    cancelAnimationFrame(queryRaf);
    queryRaf = 0;
  }
  for (const e of entries) {
    e.provider.onRecount = undefined;
    e.provider.clear();
  }
  entries = [];
  activeEntry = -1;
  /* the query and scope survive a close, browser-style — reopening re-marks */
  set({ open: false, total: 0, pos: -1 });
}

/** The bar's typing path. The input updates instantly; the scope-wide
    re-search coalesces to one pass per frame (audit round 2, B4) — in "all
    workspaces" a keystroke per panel per character would stutter. */
let queryRaf = 0;
export function findSetQuery(query: string): void {
  set({ query });
  if (queryRaf) return;
  queryRaf = requestAnimationFrame(() => {
    queryRaf = 0;
    applyQuery();
  });
}

/** Enter / Shift+Enter from the bar. */
export function findStep(dir: 1 | -1): void {
  if (!snap.query.trim()) return;
  const res = stepEntries(entries, activeEntry, dir);
  if (res.entry < 0) {
    set({ pos: -1 });
    return;
  }
  if (res.crossed && res.entry !== activeEntry && activeEntry >= 0) {
    entries[activeEntry]?.provider.clearCurrent();
  }
  activeEntry = res.entry;
  const e = entries[res.entry];
  e.current = res.index;
  if (e.provider.isVisible()) {
    e.current = e.provider.reveal(res.index);
    refreshTotals();
  } else {
    activateEntry(e, () => {
      e.current = e.provider.reveal(res.index);
      refreshTotals();
    });
    refreshTotals();
  }
}

/** The scope picker: panel → workspace → all workspaces → panel. */
export function cycleFindScope(): void {
  const order: FindScope[] = ["panel", "space", "all"];
  const next = order[(order.indexOf(snap.scope) + 1) % order.length];
  set({ scope: next });
  applyQuery();
}

/* ------------------------------------------------------------------ */
/* the DOM provider (every panel but terminals)                        */
/* ------------------------------------------------------------------ */

/* The CSS Custom Highlight API paints without touching the DOM — React
   never loses a text node to a wrapper element. Highlight names are
   PER-PROVIDER (several panels paint at once in the wider scopes), each
   with its own tiny <style> — the pseudo-class can't wildcard names, so
   static CSS can't serve; the element is removed when the panel unmounts
   (audit round 2, B3: one shared sheet grew without bound). */
let hlSeq = 0;

function claimHighlightNames(): { all: string; current: string; dispose(): void } {
  const id = ++hlSeq;
  const all = `truss-find-${id}`;
  const current = `truss-find-current-${id}`;
  const doc = typeof document !== "undefined" ? document : null;
  const el = doc?.createElement("style") ?? null;
  if (el && doc) {
    el.textContent =
      `::highlight(${all}){background-color:color-mix(in oklab,var(--t-amber) 32%,transparent);color:var(--t-fg)}` +
      `::highlight(${current}){background-color:var(--t-amber);color:#1b1305}`;
    doc.head.appendChild(el);
  }
  return { all, current, dispose: () => el?.remove() };
}

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
 * A FindProvider over a panel's DOM subtree. `root` is read lazily on every
 * operation — panels re-render freely, the ref target is what stays stable.
 */
export function domFindProvider(root: () => HTMLElement | null): FindProvider {
  const names = claimHighlightNames();
  let query = "";
  let ranges: Range[] = [];
  let current = -1;
  let observer: MutationObserver | null = null;
  let raf = 0;

  const clearMarks = () => {
    ranges = [];
    current = -1;
    if (highlightsOK()) {
      CSS.highlights.delete(names.all);
      CSS.highlights.delete(names.current);
    }
  };

  /* The current match paints ABOVE the rest: the explicit priority keeps it
     true even after a live repaint re-sets the "all" entry. */
  const paintCurrent = () => {
    const hl = new Highlight(ranges[current]);
    (hl as { priority?: number }).priority = 1;
    CSS.highlights.set(names.current, hl);
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
    if (current >= ranges.length) current = -1;
    if (highlightsOK()) {
      /* a zero-match paint drops the name outright — empty Highlight
         entries would linger in the registry for every searched panel */
      if (ranges.length) CSS.highlights.set(names.all, new Highlight(...ranges));
      else CSS.highlights.delete(names.all);
      if (current >= 0) paintCurrent();
      else CSS.highlights.delete(names.current);
    }
    return ranges.length;
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
      if (count !== before) self.onRecount?.(count, current);
    });
  };

  const watch = () => {
    const el = root();
    if (!el || observer) return;
    observer = new MutationObserver(scheduleRepaint);
    observer.observe(el, { subtree: true, childList: true, characterData: true });
  };

  const self: FindProvider = {
    setQuery(q) {
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
      return count;
    },
    reveal(i) {
      if (!ranges.length) return -1;
      current = Math.max(0, Math.min(i, ranges.length - 1));
      if (highlightsOK()) paintCurrent();
      const node = ranges[current].startContainer;
      (node.nodeType === 1 ? (node as Element) : node.parentElement)?.scrollIntoView({ block: "center", inline: "nearest" });
      return current;
    },
    clearCurrent() {
      current = -1;
      if (highlightsOK()) CSS.highlights.delete(names.current);
    },
    clear() {
      query = "";
      observer?.disconnect();
      observer = null;
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      clearMarks();
    },
    dispose() {
      self.clear();
      names.dispose(); // the per-provider style element (audit round 2, B3)
    },
    isVisible() {
      const el = root();
      /* an inactive dockview tab leaves the document entirely (portal), so
         it has no client rects; a hidden WORKSPACE keeps its geometry
         (visibility:hidden) and must be told apart by the canvas marker —
         both verified against the live DOM */
      if (!el || el.getClientRects().length === 0) return false;
      const surface = el.closest(".t-desktop-surface");
      return !surface || surface.getAttribute("data-active") === "true";
    },
  };
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
 * A FindProvider over an xterm instance. Painting every match, scrolling,
 * and stepping are the SearchAddon's own; its engine starts a search from
 * the live selection, so: selection cleared → findNext lands on the FIRST
 * match and findPrevious on the LAST (SearchEngine source); selection live
 * → the same calls step relative to it. This provider keeps the query, the
 * display position, and the live-count subscription. `get` is read lazily:
 * the terminal is (re)created on attach/font changes while the provider
 * lives on.
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
          if (!query) return;
          const recount = e.resultCount > 0 && e.resultCount !== count;
          if (recount) count = e.resultCount;
          if (e.resultIndex >= 0) current = e.resultIndex;
          if (recount || e.resultIndex >= 0) self.onRecount?.(count, current);
        });
      }
      /* paint every match (decorations ride along) without crowning a
         current yet — the controller reveals */
      t.search.findNext(q, TERM_FIND_OPTIONS);
      t.search.clearActiveDecoration();
      t.term.clearSelection();
      current = -1;
      return count;
    },
    reveal(i) {
      const t = get();
      if (!t || !count) return -1;
      const target = Math.max(0, Math.min(i, count - 1));
      if (current < 0) {
        /* no position yet: 0 is the first match, count-1 the last (the
           no-selection start points); anything between walks from the top —
           results are cached between calls, so the walk is cheap */
        t.term.clearSelection();
        if (target === count - 1 && count > 1) {
          t.search.findPrevious(query, TERM_FIND_OPTIONS);
        } else {
          t.search.findNext(query, TERM_FIND_OPTIONS); // lands on match 0
          for (let s = 0; s < target; s++) t.search.findNext(query, TERM_FIND_OPTIONS);
        }
      } else {
        const delta = target - current;
        for (let s = 0; s < delta; s++) t.search.findNext(query, TERM_FIND_OPTIONS);
        for (let s = 0; s > delta; s--) t.search.findPrevious(query, TERM_FIND_OPTIONS);
      }
      current = target;
      return current;
    },
    clearCurrent() {
      const t = get();
      t?.search.clearActiveDecoration();
      current = -1;
    },
    clear() {
      unwatch();
      const t = get();
      t?.search.clearDecorations();
      t?.search.clearActiveDecoration();
      t?.term.clearSelection();
      query = "";
      count = 0;
      current = -1;
    },
    focus() {
      get()?.term.focus();
    },
    isVisible() {
      /* same two-case rule as the DOM provider: no rects when the tab is
         detached (inactive), the canvas marker when the workspace is hidden */
      const el = get()?.term.element;
      if (!el || el.getClientRects().length === 0) return false;
      const surface = el.closest(".t-desktop-surface");
      return !surface || surface.getAttribute("data-active") === "true";
    },
  };
  return self;
}
