import { test } from "node:test";
import assert from "node:assert/strict";
import { isOvercrowded, tabCloseBehavior } from "../src/lib/tabClose";

/* the tab X used to teleport between three positions (inline-but-ml-auto,
   right-edge overlay, LEFT over the icon) and change rules across
   workspaces. These pin the single consistent contract.

   AMENDED by https://github.com/roowus/truss/issues/8: when the X overlays
   tab content (cramped / ultra), it is hover-reveal on EVERY tab — a pinned
   "always" X sat on top of the narrow active tab's truncated title. The
   roomy inline X stays always-visible (it sits beside the title, not on
   it), and inactive ultra slivers stay X-less (misclick protection). */

test("roomy tab: inline, right after the title, always visible — on every tab", () => {
  for (const active of [true, false]) {
    assert.deepEqual(tabCloseBehavior({ cramped: false, ultra: false, active }), {
      placement: "inline",
      visible: "always",
    });
  }
});

test("cramped strip: right-edge overlay, hover-reveal on EVERY tab — the active tab's X no longer covers its title (issue #8)", () => {
  assert.deepEqual(tabCloseBehavior({ cramped: true, ultra: false, active: true }), {
    placement: "overlay-right",
    visible: "hover",
  });
  assert.deepEqual(tabCloseBehavior({ cramped: true, ultra: false, active: false }), {
    placement: "overlay-right",
    visible: "hover",
  });
});

test("ultra sliver: centered mini X hover-revealed on the active tab; inactive slivers have none (never misclick-close)", () => {
  /* centered + 16px: a right-anchored 20px X on a 19px sliver overhangs 3px
     into the LEFT neighbor and eats its clicks — centering keeps it inside.
     visible: hover (issue #8) — a pinned X read as phantom text on a sliver */
  assert.deepEqual(tabCloseBehavior({ cramped: true, ultra: true, active: true }), {
    placement: "overlay-center",
    visible: "hover",
  });
  assert.deepEqual(tabCloseBehavior({ cramped: true, ultra: true, active: false }), {
    placement: "overlay-center",
    visible: "never",
  });
});

test("placement is never on the left / over the icon, in any mode", () => {
  for (const cramped of [true, false])
    for (const ultra of [true, false])
      for (const active of [true, false]) {
        const { placement } = tabCloseBehavior({ cramped, ultra, active });
        assert.ok(
          placement === "inline" || placement === "overlay-right" || placement === "overlay-center",
          `unexpected placement ${placement}`,
        );
      }
});

test("isOvercrowded: natural widths + per-tab chrome vs strip width", () => {
  assert.equal(isOvercrowded([100, 100], 300), false); // 276 <= 300
  assert.equal(isOvercrowded([100, 100], 276), false); // exact fit (+2 slack)
  assert.equal(isOvercrowded([100, 100], 270), true); // squeezed
  assert.equal(isOvercrowded([], 100), false); // no tabs
  assert.equal(isOvercrowded([80], 0), true); // hidden strip (clientWidth 0) reads crowded, corrects on show
  assert.equal(isOvercrowded([80, 80, 80], 400, 10), false); // custom chrome width respected
});
