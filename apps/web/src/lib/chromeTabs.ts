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
 *   - indicators (the truss status dot / pending badge — extras Chrome
 *     doesn't have) drop below their own floor, the way the title drops
 *     below CHROME_TAB_TITLE_MIN: a narrow titled tab keeps a readable
 *     title instead of a dot and nothing else (issue #129).
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

/**
 * The close X's slot width at a titled tab's trailing edge: the w-5 (20px)
 * button plus its right-0.5 (2px) offset, as Workspace.tsx renders it.
 * Reserved as trailing padding when the X is hover-hidden or absent, so an
 * indicator never kisses the edge.
 */
export const CHROME_TAB_CLOSE_SLOT = 22;

/**
 * Below this width a titled tab hides its indicators (the status dot and
 * the pending badge) — the same tradeoff slivers make one band lower
 * (issue #129). The #125 reserve pushed a dotted tab's fixed row content
 * to 64px, so between CHROME_TAB_TITLE_MIN and ~92px the title span sat
 * entirely inside the 14px fade mask: a dot and no readable title. The
 * floor is the titled floor plus exactly the reserve a shown indicator
 * forces — at this width a dotted tab's title span is 30px again, the
 * room it had at CHROME_TAB_TITLE_MIN before the reserve existed.
 */
export const CHROME_TAB_INDICATOR_MIN = CHROME_TAB_TITLE_MIN + CHROME_TAB_CLOSE_SLOT;

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
  /**
   * true when the tab may render its indicators (status dot, pending
   * badge). Below CHROME_TAB_INDICATOR_MIN a titled tab drops them so the
   * title keeps readable room (issue #129) — and with no indicator
   * showing, the #125 trailing reserve is 0 too.
   */
  showIndicator: boolean;
}

/**
 * The width a strip's tabs may occupy: the header row minus its fixed
 * action trays (the "+" / maximize buttons), never negative. The UI must
 * measure THIS — never the tabs container's own width. Dockview
 * content-sizes that container (flex: 0 1 auto next to a flex-grow void),
 * so reading it while also writing tab widths into it is a feedback loop
 * that ratchets the strip narrower on every click.
 */
export function chromeTabsAvailableWidth(headerWidth: number, trayWidths: number[]): number {
  let w = Number.isFinite(headerWidth) ? headerWidth : 0;
  for (const t of trayWidths) w -= Number.isFinite(t) ? t : 0;
  return Math.max(0, w);
}

/**
 * The breathing room a titled tab reserves at its trailing edge (issue
 * #125). The X is hover-revealed or absent on most tabs (the #95 matrix
 * above), which left the status dot as the row's last in-flow element,
 * flush against the tab's right edge. Reserving the X's slot keeps the dot
 * off the edge AND lets the hover-revealed X appear without shifting
 * anything (the #21 no-shift spirit — reserve, not reflow).
 *
 * Returns 0 when the X is inline (it IS the trailing element), on slivers
 * (no title, no dot), or when no indicator is showing (the title fades to
 * the edge, like Chrome).
 */
export function tabTrailingReserve(view: ChromeTabView, hasIndicator: boolean): number {
  if (!view.showTitle || !hasIndicator) return 0;
  return view.showClose === "always" ? 0 : CHROME_TAB_CLOSE_SLOT;
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
      perTab[tab.id] = { showTitle: false, showClose: "never", closeOverIcon: false, showIndicator: false };
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
      /* indicators (dot/badge) are truss extras Chrome doesn't have: below
         the indicator floor a titled tab drops them for title room, the
         way a sliver drops the title itself */
      showIndicator: titled && width >= CHROME_TAB_INDICATOR_MIN,
    };
  }
  return { width, perTab };
}
