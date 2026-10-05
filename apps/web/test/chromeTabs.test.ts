import { test } from "node:test";
import assert from "node:assert/strict";

/* SPEC-TESTS for a Chrome-parity tab strip — https://github.com/roowus/truss/issues/95
   ("The entire tab sizing system + the X-to-close layout need a complete
   redo — inconsistent and buggy; just make it like Chrome handles every
   case"). These FAIL on purpose today: they pin the contract a fix must
   satisfy.

   This CONSOLIDATES and (per the issue) AMENDS the earlier contracts —
   review table in the issue:
   - #23's "focused tab fully displayed" is SUPERSEDED: Chrome compresses
     every tab uniformly, the active one included (it's marked by color and
     an always-ready X, not by width);
   - #8's "placement never over the icon" is AMENDED for slivers: Chrome's
     favicon swap puts the X over the icon on hover at sliver widths;
   - #21's hysteresis and #34's pure-manager contract compose unchanged
     (thresholds now come from this module's constants).

   Chrome's model, pinned as one pure function — src/lib/chromeTabs.ts:

     chromeTabLayout({ stripWidth, tabs: [{ id, active?, pinned? }] }) →
       { width, perTab: Record<id, { showTitle, showClose, closeOverIcon,
       showIndicator }> }

   (showIndicator joined the view with #129: titled tabs below
   CHROME_TAB_INDICATOR_MIN hide the dot/badge so the title keeps readable
   room. It gates only the truss-specific extras — the Chrome matrix above
   is unchanged. Its contract lives in tabIndicator.test.ts.)

     - width: UNIFORM across all tabs every time =
       clamp(floor(stripWidth / count), CHROME_TAB_ICON, CHROME_TAB_MAX);
     - showTitle: width >= CHROME_TAB_TITLE_MIN (slivers go icon-only);
     - showClose ("always" | "hover" | "never"):
       roomy (title visible): active → always, others → hover;
       narrow (title hidden but not sliver): active → hover, others → never;
       sliver (icon-only): active → hover + closeOverIcon, others → never;
       pinned (Chrome sense) → never, ever;
     - closeOverIcon is ONLY true at sliver width (the X never sits on the
       title text — the original #8 complaint holds);
     - degenerate inputs (0 width, 0 tabs) never throw. */

interface ChromeTabInput {
  id: string;
  active?: boolean;
  pinned?: boolean;
}
interface ChromeTabView {
  showTitle: boolean;
  showClose: "always" | "hover" | "never";
  closeOverIcon: boolean;
  showIndicator: boolean;
}
interface ChromeTabsModule {
  CHROME_TAB_MAX: number;
  CHROME_TAB_TITLE_MIN: number;
  CHROME_TAB_ICON: number;
  chromeTabLayout(input: { stripWidth: number; tabs: ChromeTabInput[] }): {
    width: number;
    perTab: Record<string, ChromeTabView>;
  };
}

async function load(): Promise<ChromeTabsModule | null> {
  const spec = "../src/lib/chromeTabs"; // variable specifier: typechecks before the module exists
  return import(spec).catch(() => null);
}

test("src/lib/chromeTabs.ts exists with Chrome-scale constants", async () => {
  const mod = await load();
  assert.ok(mod, "src/lib/chromeTabs.ts must export chromeTabLayout + the width constants — see issue #95");
  assert.ok(mod.CHROME_TAB_MAX >= 200 && mod.CHROME_TAB_MAX <= 260, "Chrome's roomy tab is ~240px");
  assert.ok(mod.CHROME_TAB_TITLE_MIN >= 56 && mod.CHROME_TAB_TITLE_MIN < mod.CHROME_TAB_MAX, "below this, icon-only");
  assert.ok(mod.CHROME_TAB_ICON >= 28 && mod.CHROME_TAB_ICON < mod.CHROME_TAB_TITLE_MIN, "the sliver floor sits under the title minimum");
});

test("UNIFORM width always — the active tab included (supersedes #23's focused-exempt rule)", async () => {
  const mod = await load();
  assert.ok(mod, "chromeTabs module must exist (see module test)");
  const tabs = [
    { id: "a", active: true },
    { id: "b" },
    { id: "c" },
  ];
  const wide = mod.chromeTabLayout({ stripWidth: 1200, tabs });
  assert.equal(wide.width, mod.CHROME_TAB_MAX, "roomy: everyone at the standard width");
  const narrow = mod.chromeTabLayout({ stripWidth: 300, tabs });
  assert.equal(narrow.width, 100, "300px / 3 tabs = 100px each");
  assert.equal(narrow.width, Math.floor(300 / 3), "uniform share, floored");
  /* the point: identical widths, not per-tab natural widths */
  assert.equal(typeof narrow.perTab.a.showTitle, "boolean");
});

test("the close matrix is exactly Chrome's", async () => {
  const mod = await load();
  assert.ok(mod, "chromeTabs module must exist (see module test)");
  const M = mod;

  const at = (stripWidth: number, tabs: ChromeTabInput[]) =>
    M.chromeTabLayout({ stripWidth, tabs });

  /* roomy: title visible; active always, inactive hover */
  const roomy = at(M.CHROME_TAB_MAX * 3, [{ id: "x", active: true }, { id: "y" }, { id: "z" }]);
  assert.ok(roomy.width >= M.CHROME_TAB_TITLE_MIN);
  assert.equal(roomy.perTab.x.showClose, "always", "roomy active tab: X pinned");
  assert.equal(roomy.perTab.y.showClose, "hover", "roomy inactive: hover-reveal");
  assert.equal(roomy.perTab.x.showTitle, true);

  /* narrow: title still visible but tight; active drops to hover, inactive loses the X */
  const tight = at(M.CHROME_TAB_TITLE_MIN * 3, [{ id: "x", active: true }, { id: "y" }, { id: "z" }]);
  assert.equal(tight.perTab.y.showClose, "never", "tight inactive: no X (Chrome's rule)");
  assert.equal(tight.perTab.x.showClose, "hover", "tight active: hover only");

  /* sliver: icon-only; active's X hovers OVER THE ICON (the #8 amendment) */
  const sliver = at(M.CHROME_TAB_ICON * 3, [{ id: "x", active: true }, { id: "y" }, { id: "z" }]);
  assert.equal(sliver.perTab.x.showTitle, false, "slivers show no title");
  assert.equal(sliver.perTab.x.showClose, "hover");
  assert.equal(sliver.perTab.x.closeOverIcon, true, "the favicon swap — Chrome's sliver rule");
  assert.equal(sliver.perTab.y.showClose, "never", "inactive slivers: never (misclick protection stands)");

  /* pinned tabs (Chrome sense): icon-only, no X, ever */
  const pinned = at(M.CHROME_TAB_MAX * 2, [{ id: "p", pinned: true }, { id: "q", active: true }]);
  assert.equal(pinned.perTab.p.showClose, "never", "a pinned tab can never be closed by accident");
  assert.equal(pinned.perTab.p.showTitle, false, "pinned tabs are icon-only even when roomy");
});

test("the X NEVER sits on title text; icon-overlay only at sliver width", async () => {
  const mod = await load();
  assert.ok(mod, "chromeTabs module must exist (see module test)");
  for (let w = 60; w <= 900; w += 17) {
    const out = mod.chromeTabLayout({ stripWidth: w, tabs: [{ id: "a", active: true }, { id: "b" }, { id: "c" }] });
    for (const t of Object.values(out.perTab)) {
      if (t.showTitle) {
        assert.equal(t.closeOverIcon, false, `width ${out.width}: a titled tab never overlays its icon area`);
      }
      if (t.closeOverIcon) {
        assert.equal(t.showTitle, false, "icon-overlay only when icon-only");
        assert.ok(out.width < mod.CHROME_TAB_TITLE_MIN, "icon-overlay only at sliver width");
      }
    }
  }
});

test("fuzz: every width × count is uniform, in-bounds, crash-free", async () => {
  const mod = await load();
  assert.ok(mod, "chromeTabs module must exist (see module test)");
  for (let n = 1; n <= 14; n++) {
    for (let w = 0; w <= 1400; w += 61) {
      const tabs = Array.from({ length: n }, (_, i) => ({ id: `t${i}`, active: i === 0 }));
      const layout: ReturnType<ChromeTabsModule["chromeTabLayout"]> = mod.chromeTabLayout({ stripWidth: w, tabs });
      assert.ok(Number.isFinite(layout.width) && layout.width > 0, `n=${n} w=${w}: sane width`);
      assert.ok(layout.width <= mod.CHROME_TAB_MAX, "never above the standard");
      assert.ok(w === 0 || layout.width >= mod.CHROME_TAB_ICON || n === 0, "never below the icon floor");
      assert.equal(Object.keys(layout.perTab).length, n, "every tab described");
    }
  }
  assert.doesNotThrow(() => mod.chromeTabLayout({ stripWidth: 400, tabs: [] }), "empty strip");
});
