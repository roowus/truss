import { test } from "node:test";
import assert from "node:assert/strict";
import { tabClosePlacement } from "../src/lib/tabClose";
import { chromeTabLayout, CHROME_TAB_ICON, CHROME_TAB_MAX, CHROME_TAB_TITLE_MIN } from "../src/lib/chromeTabs";

/* The X's PLACEMENT contract over the Chrome-parity layout (issue #95).
   chromeTabs.test.ts pins the width/visibility matrix; this file pins where
   the X is allowed to sit.

   AMENDMENTS landing with #95:
   - the "placement never over the icon" pin RELAXES for slivers: Chrome's
     favicon swap puts the hover X exactly where the icon was ("overlay-icon")
   - the roomy "always visible on every tab" pin narrows to the ACTIVE tab:
     inactive roomy tabs hover-reveal (Chrome's matrix)
   - the old overlay-center ultra-sliver placement is gone: slivers are
     icon-only now, so the favicon swap IS the centered X
   What stands: the X never sits on title TEXT (the original #8 complaint)
   and never hangs off the tab's left edge. */

const viewAt = (stripWidth: number, tab: { active?: boolean; pinned?: boolean }, count = 3) =>
  chromeTabLayout({
    stripWidth,
    tabs: Array.from({ length: count }, (_, i) => (i === 0 ? { id: "t", ...tab } : { id: `o${i}` })),
  }).perTab.t;

test("roomy strip: the active tab's X is inline + pinned; inactive tabs hover-reveal (Chrome's matrix)", () => {
  const active = viewAt(CHROME_TAB_MAX * 3, { active: true });
  assert.equal(active.showClose, "always");
  assert.equal(tabClosePlacement(active), "inline", "roomy active: in flow, right after the title");
  const inactive = viewAt(CHROME_TAB_MAX * 3, {});
  assert.equal(inactive.showClose, "hover", "amended: inactive roomy tabs no longer pin the X");
  assert.equal(tabClosePlacement(inactive), "overlay-right", "hover X floats at the right edge, off the title");
});

test("tight strip (title still visible): hover-reveal on the active tab only, never pinned over the truncated title (issue #8 stands)", () => {
  const active = viewAt(CHROME_TAB_TITLE_MIN * 3, { active: true });
  assert.equal(active.showClose, "hover");
  assert.equal(tabClosePlacement(active), "overlay-right");
  const inactive = viewAt(CHROME_TAB_TITLE_MIN * 3, {});
  assert.equal(inactive.showClose, "never", "inactive tight tabs have no X to misclick");
  assert.equal(tabClosePlacement(inactive), null);
});

test("sliver: the active tab's hover X sits OVER THE ICON — the favicon swap (the #8 never-over-icon pin relaxes for slivers)", () => {
  const active = viewAt(CHROME_TAB_ICON * 3, { active: true });
  assert.equal(active.showTitle, false, "slivers are icon-only, so no title text is ever covered");
  assert.equal(active.closeOverIcon, true);
  assert.equal(tabClosePlacement(active), "overlay-icon");
  const inactive = viewAt(CHROME_TAB_ICON * 3, {});
  assert.equal(inactive.showClose, "never", "inactive slivers: never (misclick protection stands)");
  assert.equal(tabClosePlacement(inactive), null);
});

test("pinned tabs (Chrome sense): no X in any band — never closeable by click", () => {
  for (const stripWidth of [CHROME_TAB_MAX * 3, CHROME_TAB_TITLE_MIN * 3, CHROME_TAB_ICON * 3]) {
    const pinned = viewAt(stripWidth, { pinned: true, active: true });
    assert.equal(pinned.showClose, "never");
    assert.equal(tabClosePlacement(pinned), null);
  }
});

test("invariant sweep: the X NEVER sits on title text; over-the-icon only at sliver width", () => {
  for (let w = 60; w <= 900; w += 13) {
    for (const active of [true, false]) {
      const view = viewAt(w, { active });
      const placement = tabClosePlacement(view);
      if (view.showTitle) {
        assert.notEqual(placement, "overlay-icon", `w=${w}: a titled tab never puts the X over its icon`);
      }
      if (placement === "overlay-icon") {
        assert.equal(view.showTitle, false, "the favicon swap exists only on icon-only slivers");
      }
    }
  }
});
