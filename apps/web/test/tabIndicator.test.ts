import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* SPEC-TESTS for the narrow-tab indicator floor — https://github.com/roowus/truss/issues/129
   ("Narrow titled tabs (72–92px) with a status dot lose the whole title to
   the fade mask"). These FAIL on purpose today: they pin the contract a
   fix must satisfy.

   Why (raised by the PR #127 audit, finding B2): the #125 trailing reserve
   (22px, CHROME_TAB_CLOSE_SLOT) pushed a dotted tab's fixed row content to
   64px (pl 8 + icon 12 + gaps 12 + dot 6 + padding 4+22), so at the titled
   floor CHROME_TAB_TITLE_MIN (72) the title span is 8px — entirely inside
   the 14px .t-fade-r mask. A dot + pending badge collapses it to zero.
   Reachable at ordinary widths (8 tabs on a ~600px strip -> 75px each).

   The contract: chromeTabs.ts gains —

     CHROME_TAB_INDICATOR_MIN = CHROME_TAB_TITLE_MIN + CHROME_TAB_CLOSE_SLOT
     ChromeTabView.showIndicator: boolean

   - below the indicator floor a titled tab hides its indicators (dot AND
     badge), the same tradeoff slivers already make one band lower — the
     title keeps its pre-#125 room;
   - the floor is the titled floor plus exactly the reserve a shown
     indicator forces: at CHROME_TAB_INDICATOR_MIN a dotted tab's title
     span is 30px, the same room a dotted tab had at CHROME_TAB_TITLE_MIN
     before the reserve existed (72 - 42);
   - the reserve follows the indicator: hidden indicators mean no reserve
     (the #125 "no indicator -> 0" rule), so padding falls back to pr-1.

   AMENDED (PR #130 audit round 1, finding B1): the badge costs more than
   the dot, so it gets its own, higher floor —

     CHROME_TAB_BADGE_SLOT (the badge's row footprint: the 17px pill plus
       the 6px gap it adds)
     CHROME_TAB_BADGE_MIN = CHROME_TAB_INDICATOR_MIN + CHROME_TAB_BADGE_SLOT
     ChromeTabView.showBadge: boolean

   - between the two floors a titled tab shows the dot but hides the badge
     (a dot + badge row is 87px of fixed content — at 94px its title span
     is 7px, the exact unreadable state this issue names);
   - at CHROME_TAB_BADGE_MIN the dot + badge row keeps the same 30px of
     title room the floor guarantees the dot-only row.

   The #95 matrix is untouched: width, showTitle, showClose and
   closeOverIcon behave exactly as before — showIndicator/showBadge only
   gate the truss-specific extras Chrome doesn't have. */

interface ChromeTabsIndicator {
  CHROME_TAB_INDICATOR_MIN: number;
  CHROME_TAB_BADGE_MIN: number;
  CHROME_TAB_BADGE_SLOT: number;
  CHROME_TAB_TITLE_MIN: number;
  CHROME_TAB_CLOSE_SLOT: number;
  CHROME_TAB_CLOSE_MIN: number;
  CHROME_TAB_MAX: number;
  CHROME_TAB_ICON: number;
  chromeTabLayout(input: { stripWidth: number; tabs: { id: string; active?: boolean; pinned?: boolean }[] }): {
    width: number;
    perTab: Record<string, { showTitle: boolean; showIndicator: boolean; showBadge: boolean }>;
  };
}

async function load(): Promise<ChromeTabsIndicator | null> {
  const spec = "../src/lib/chromeTabs"; // the module exists; the exports are the contract
  const mod: any = await import(spec);
  return typeof mod?.CHROME_TAB_INDICATOR_MIN === "number" && typeof mod?.CHROME_TAB_BADGE_MIN === "number" ? mod : null;
}

test("chromeTabs.ts exports CHROME_TAB_INDICATOR_MIN with the derivation the fix needs", async () => {
  const mod = await load();
  assert.ok(mod, "src/lib/chromeTabs.ts must export CHROME_TAB_INDICATOR_MIN — see issue #129");
  assert.equal(
    mod.CHROME_TAB_INDICATOR_MIN,
    mod.CHROME_TAB_TITLE_MIN + mod.CHROME_TAB_CLOSE_SLOT,
    "the indicator costs exactly the reserve it forces — the floor rises by that, no more",
  );
  assert.ok(
    mod.CHROME_TAB_INDICATOR_MIN < mod.CHROME_TAB_CLOSE_MIN,
    "indicators come back well before the roomy band — they must not vanish across the whole tight range",
  );

  /* the badge floor (audit round 1, B1): the dot+badge row is the dot row
     plus exactly the badge's slot, so the floor rises by exactly that */
  assert.equal(
    mod.CHROME_TAB_BADGE_MIN,
    mod.CHROME_TAB_INDICATOR_MIN + mod.CHROME_TAB_BADGE_SLOT,
    "the badge costs its slot on top of the indicator floor — no more, no less",
  );
  assert.ok(mod.CHROME_TAB_BADGE_SLOT >= 17 + 6, "the slot covers the 17px pill plus its 6px row gap");
  assert.ok(
    mod.CHROME_TAB_BADGE_MIN <= mod.CHROME_TAB_CLOSE_MIN,
    "the badge is back by the roomy band at the latest — it must not vanish across the whole tight range",
  );
});

test("a dotted tab at the indicator floor keeps its pre-reserve title room", async () => {
  const mod = await load();
  assert.ok(mod, "CHROME_TAB_INDICATOR_MIN must exist (see module test)");
  /* dotted fixed row content is 64px (pl 8 + icon 12 + gaps 12 + dot 6 +
     padding 4+22); before #125 it was 42px, so a dotted tab at the old
     floor had a 30px span — 16px clear of the 14px fade mask */
  const FIXED_WITH_DOT_AND_RESERVE = 64;
  const PRE_RESERVE_SPAN_AT_FLOOR = mod.CHROME_TAB_TITLE_MIN - 42;
  assert.ok(
    mod.CHROME_TAB_INDICATOR_MIN - FIXED_WITH_DOT_AND_RESERVE >= PRE_RESERVE_SPAN_AT_FLOOR,
    "at the floor the title is at least as readable as a dotted tab was at 72px before #125",
  );

  /* the dot + badge row (audit round 1, B1): the badge adds its slot to
     the dotted row's 64px; the badge floor must leave the same room */
  const FIXED_WITH_DOT_BADGE_AND_RESERVE = FIXED_WITH_DOT_AND_RESERVE + mod.CHROME_TAB_BADGE_SLOT;
  assert.ok(
    mod.CHROME_TAB_BADGE_MIN - FIXED_WITH_DOT_BADGE_AND_RESERVE >= PRE_RESERVE_SPAN_AT_FLOOR,
    "a dot + badge tab at the badge floor keeps the same readable title — the case the issue names",
  );
});

test("showIndicator follows the width: on at/above the floor, off below it and on slivers", async () => {
  const mod = await load();
  assert.ok(mod, "CHROME_TAB_INDICATOR_MIN must exist (see module test)");
  const at = (stripWidth: number, tab: { active?: boolean; pinned?: boolean } = {}, count = 3) =>
    mod.chromeTabLayout({
      stripWidth,
      tabs: Array.from({ length: count }, (_, i) => (i === 0 ? { id: "t", ...tab } : { id: `o${i}` })),
    });

  const wide = at(mod.CHROME_TAB_INDICATOR_MIN * 3, { active: true });
  assert.equal(wide.width, mod.CHROME_TAB_INDICATOR_MIN);
  assert.equal(wide.perTab.t.showTitle, true, "still a titled tab");
  assert.equal(wide.perTab.t.showIndicator, true, "at the floor the dot shows");

  const narrow = at((mod.CHROME_TAB_INDICATOR_MIN - 1) * 3, { active: true });
  assert.equal(narrow.width, mod.CHROME_TAB_INDICATOR_MIN - 1);
  assert.equal(narrow.perTab.t.showTitle, true, "1px below the floor the tab is still titled");
  assert.equal(narrow.perTab.t.showIndicator, false, "but the indicator hides so the title keeps its room");

  const sliver = at(mod.CHROME_TAB_ICON * 3, { active: true });
  assert.equal(sliver.perTab.t.showIndicator, false, "slivers show no indicators (they show no title)");
  assert.equal(sliver.perTab.t.showBadge, false, "slivers show no badge either");

  const pinned = at(mod.CHROME_TAB_MAX * 2, { pinned: true }, 2);
  assert.equal(pinned.perTab.t.showIndicator, false, "pinned tabs are icon-only — no indicators");
  assert.equal(pinned.perTab.t.showBadge, false, "pinned tabs show no badge");

  /* between the two floors: the dot shows, the badge hides (audit round 1,
     B1 — a dot + badge row would still swallow the title here) */
  const mid = at(mod.CHROME_TAB_INDICATOR_MIN * 3, {});
  assert.equal(mid.perTab.t.showIndicator, true, "mid-band: the dot fits");
  assert.equal(mid.perTab.t.showBadge, false, "mid-band: the badge waits for its own floor");
  const badgeFloor = at(mod.CHROME_TAB_BADGE_MIN * 3, {});
  assert.equal(badgeFloor.width, mod.CHROME_TAB_BADGE_MIN);
  assert.equal(badgeFloor.perTab.t.showBadge, true, "at the badge floor the badge shows");

  /* every titled width below the floor hides indicators; every width at or
     above shows them — no gap band, no overlap band */
  for (let w = mod.CHROME_TAB_TITLE_MIN * 3; w <= mod.CHROME_TAB_CLOSE_MIN * 3; w += 7) {
    const out = at(w);
    const want: boolean = out.width >= mod.CHROME_TAB_INDICATOR_MIN;
    assert.equal(out.perTab.t.showIndicator, want, `width ${out.width}: showIndicator is exactly the floor test`);
    if (!want) assert.equal(out.perTab.t.showTitle, true, `width ${out.width}: the band stays titled`);
    const wantBadge: boolean = out.width >= mod.CHROME_TAB_BADGE_MIN;
    assert.equal(out.perTab.t.showBadge, wantBadge, `width ${out.width}: showBadge is exactly the badge-floor test`);
    if (wantBadge) assert.ok(out.perTab.t.showIndicator, `width ${out.width}: the badge never shows without the dot's floor passed`);
  }
});

test("read-through: the tab row gates dot on showIndicator, badge on showBadge, and the reserve on both", () => {
  const src = readFileSync(new URL("../src/components/Workspace.tsx", import.meta.url), "utf8");
  const dotGates = src.match(/view\.showIndicator/g) ?? [];
  assert.ok(
    dotGates.length >= 2,
    "Workspace.tsx must gate the state dot AND the trailing-reserve input on view.showIndicator — otherwise a narrow titled tab still loses its title to the fade mask",
  );
  const badgeGates = src.match(/view\.showBadge/g) ?? [];
  assert.ok(
    badgeGates.length >= 2,
    "Workspace.tsx must gate the pending badge AND the trailing-reserve input on view.showBadge — otherwise a mid-band tab (94–116px) with a pending request still loses its title (audit round 1, B1)",
  );
});
