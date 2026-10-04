/**
 * Chrome-parity tab strip: ONE pure function decides every tab's width and
 * close-X behavior (issue #95). This is the strip's decision core — the UI
 * measures the strip, calls this, and renders what it says. No probes, no
 * per-tab natural widths, no mode-dependent verdicts that can oscillate.
 *
 * Chrome's model:
 *   - every tab in a strip is the SAME width, always — the active tab
 *     included (it reads via highlight + an always-ready X, not extra
 *     width). Width = the strip shared evenly, clamped to the floors below.
 *   - below the title minimum the tab goes icon-only (a sliver).
 *   - the close X follows Chrome's matrix: roomy tabs pin the X on the
 *     active tab and hover-reveal it on the rest; tighter strips drop the
 *     inactive X entirely and hover-reveal on the active tab; slivers swap
 *     the favicon for the X on hover (active only). Pinned tabs (Chrome
 *     sense) are icon-only and can never be closed by click.
 *   - the X never sits on title TEXT — the icon-overlay (favicon swap) only
 *     happens on icon-only slivers.
 */

/** Chrome's standard tab width when the strip has room (~240px). */
export const CHROME_TAB_MAX = 240;

/** Below this width the title is dropped: the tab is an icon-only sliver. */
export const CHROME_TAB_TITLE_MIN = 72;

/**
 * The sliver floor — Chrome stops compressing at the pinned-tab width and
 * lets the strip overflow instead of shrinking tabs into unclickable mush.
 */
export const CHROME_TAB_ICON = 40;

/**
 * At or above this width a tab is "roomy": the active tab keeps its X
 * pinned and inactive tabs hover-reveal it. Below it (title still visible
 * down to CHROME_TAB_TITLE_MIN) the active tab drops to hover-reveal and
 * inactive tabs lose the X entirely — Chrome's rule once tabs get tight.
 */
export const CHROME_TAB_CLOSE_MIN = 120;

export interface ChromeTabInput {
  id: string;
  active?: boolean;
  pinned?: boolean;
}

export interface ChromeTabView {
  showTitle: boolean;
  showClose: "always" | "hover" | "never";
  /** true only on slivers: the hover X takes the favicon's place. */
  closeOverIcon: boolean;
}

export function chromeTabLayout(input: { stripWidth: number; tabs: ChromeTabInput[] }): {
  width: number;
  perTab: Record<string, ChromeTabView>;
} {
  const { stripWidth, tabs } = input;
  const count = tabs.length;
  /* Uniform share, floored, clamped into [CHROME_TAB_ICON, CHROME_TAB_MAX].
     Degenerate inputs never throw: an empty strip reports the standard
     width; a zero/NaN share clamps up to the icon floor. */
  const share = count > 0 ? Math.floor(stripWidth / count) : CHROME_TAB_MAX;
  const width = Math.min(CHROME_TAB_MAX, Math.max(CHROME_TAB_ICON, Number.isFinite(share) ? share : CHROME_TAB_ICON));

  const titled = width >= CHROME_TAB_TITLE_MIN;
  const roomy = width >= CHROME_TAB_CLOSE_MIN;
  const perTab: Record<string, ChromeTabView> = {};
  for (const tab of tabs) {
    if (tab.pinned) {
      /* Chrome-sense pinned: icon-only, no X, ever — no accidental closes. */
      perTab[tab.id] = { showTitle: false, showClose: "never", closeOverIcon: false };
      continue;
    }
    const showClose: ChromeTabView["showClose"] = roomy
      ? tab.active
        ? "always"
        : "hover"
      : tab.active
        ? "hover"
        : "never";
    perTab[tab.id] = {
      showTitle: titled,
      showClose,
      /* the favicon swap exists only on icon-only slivers — the X never
         overlays title text */
      closeOverIcon: showClose !== "never" && !titled,
    };
  }
  return { width, perTab };
}
