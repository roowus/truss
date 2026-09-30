import { test } from "node:test";
import assert from "node:assert/strict";

/* SPEC-TESTS for uniform tab widths — https://github.com/roowus/truss/issues/23
   ("Standardize tab lengths; uniform compression under overcrowding with the
   focused tab fully displayed"). These FAIL on purpose today: they pin the
   contract a fix must satisfy.

   Today tabs size to their titles (content width + `flex-shrink: 1;
   min-width: 0` in index.css:103), so tabs are different lengths and compress
   proportionally — long titles hog width, short ones collapse first, and the
   focused tab is squeezed like any other.

   The contract: a pure src/lib/tabStrip.ts —

     STANDARD_TAB_WIDTH: number   // every roomy tab is exactly this wide
     MIN_TAB_WIDTH: number        // compression floor for inactive tabs
     isStripOvercrowded(tabs, stripWidth): boolean
     layoutTabStrip({ stripWidth, tabs }): { id, width }[]

   Rules it must honor (Chrome-flavored, per the issue):
   - roomy (every tab fits at STANDARD): ALL tabs are exactly
     STANDARD_TAB_WIDTH — uniform lengths, regardless of title length;
   - overcrowded: the ACTIVE tab keeps enough width to be fully displayed
     (never below min(natural, STANDARD)); the inactive tabs share the rest
     EQUALLY (uniform compression — no proportional hogging), never below
     MIN_TAB_WIDTH unless the strip can't fit the floor at all;
   - widths are always finite, positive, and deterministic; the total never
     exceeds the strip unless the minimums alone already do.

   Interaction with the close-X rules (#8, #21) is pinned in the issue: the
   active tab is never compressed, so it always composes as "roomy"; the
   ultra-sliver X rules apply only to inactive tabs from here on. The probe
   machinery (natural widths) stays — it feeds the active tab's full width. */

interface TabSpec {
  id: string;
  naturalWidth: number;
  active: boolean;
}
interface TabStripModule {
  STANDARD_TAB_WIDTH: number;
  MIN_TAB_WIDTH: number;
  isStripOvercrowded(tabs: TabSpec[], stripWidth: number): boolean;
  layoutTabStrip(input: { stripWidth: number; tabs: TabSpec[] }): { id: string; width: number }[];
}

async function load(): Promise<TabStripModule | null> {
  const spec = "../src/lib/tabStrip"; // variable specifier: typechecks even before the module exists
  return import(spec).catch(() => null);
}

const tabs3 = (activeIdx = 0): TabSpec[] => [
  { id: "a", naturalWidth: 132, active: activeIdx === 0 },
  { id: "b", naturalWidth: 208, active: activeIdx === 1 },
  { id: "c", naturalWidth: 96, active: activeIdx === 2 },
];

test("src/lib/tabStrip.ts exists with sane width constants", async () => {
  const ts = await load();
  assert.ok(ts, "src/lib/tabStrip.ts must export layoutTabStrip/isStripOvercrowded + width constants — see issue #23");
  assert.ok(ts.STANDARD_TAB_WIDTH >= 140 && ts.STANDARD_TAB_WIDTH <= 240, "the uniform roomy width is a real tab, not a sliver");
  assert.ok(ts.MIN_TAB_WIDTH >= 40 && ts.MIN_TAB_WIDTH < ts.STANDARD_TAB_WIDTH, "the compression floor sits below standard");
});

test("roomy: every tab is exactly STANDARD — uniform lengths regardless of title", async () => {
  const ts = await load();
  assert.ok(ts, "tabStrip module must exist (see constants test)");
  const strip = ts.STANDARD_TAB_WIDTH * 3 + 50;
  assert.equal(ts.isStripOvercrowded(tabs3(), strip), false);

  const widths = ts.layoutTabStrip({ stripWidth: strip, tabs: tabs3() });
  assert.deepEqual(widths.map((w) => w.width), [ts.STANDARD_TAB_WIDTH, ts.STANDARD_TAB_WIDTH, ts.STANDARD_TAB_WIDTH], "a 96px-natural tab and a 208px-natural tab read the SAME width today they don't");
  assert.ok(widths.reduce((a, w) => a + w.width, 0) <= strip, "fits the strip");
});

test("overcrowded: active tab stays fully displayed; inactives compress UNIFORMLY", async () => {
  const ts = await load();
  assert.ok(ts, "tabStrip module must exist (see constants test)");
  /* two standard + squeeze: strip fits 2.4 standards for 3 tabs */
  const strip = Math.floor(ts.STANDARD_TAB_WIDTH * 2.4);
  const tabs = tabs3(1); // b (natural 208) is active
  assert.equal(ts.isStripOvercrowded(tabs, strip), true, "three tabs at 2.4 standards is crowded");

  const widths = ts.layoutTabStrip({ stripWidth: strip, tabs });
  const w = (id: string) => widths.find((x) => x.id === id)!.width;

  assert.ok(w("b") >= Math.min(208, ts.STANDARD_TAB_WIDTH), "the focused tab is never squeezed below its full (capped) width");
  assert.equal(w("a"), w("c"), "inactive tabs compress UNIFORMLY — today they squeeze proportionally to title length");
  assert.ok(w("a") < ts.STANDARD_TAB_WIDTH, "inactives absorb the squeeze");
  assert.ok(w("a") >= ts.MIN_TAB_WIDTH, "…but never below the floor");
});

test("the focused tab is the wide one regardless of which is active", async () => {
  const ts = await load();
  assert.ok(ts, "tabStrip module must exist (see constants test)");
  const strip = Math.floor(ts.STANDARD_TAB_WIDTH * 2.2);
  for (const activeIdx of [0, 1, 2]) {
    const tabs = tabs3(activeIdx);
    const widths = ts.layoutTabStrip({ stripWidth: strip, tabs });
    const activeId = tabs[activeIdx].id;
    const activeW = widths.find((x) => x.id === activeId)!.width;
    const others = widths.filter((x) => x.id !== activeId).map((x) => x.width);
    assert.ok(others.every((o) => activeW >= o), `active=${activeId}: focused tab is the widest`);
    assert.ok(others[0] === others[1], `active=${activeIdx}: inactives uniform`);
  }
});

test("extreme squeeze: inactives floor at MIN_TAB_WIDTH; active still readable", async () => {
  const ts = await load();
  assert.ok(ts, "tabStrip module must exist (see constants test)");
  const tabs = Array.from({ length: 9 }, (_, i) => ({ id: `t${i}`, naturalWidth: 150, active: i === 4 }));
  const strip = ts.STANDARD_TAB_WIDTH; // absurdly narrow
  const widths = ts.layoutTabStrip({ stripWidth: strip, tabs });
  for (const w of widths) {
    assert.ok(Number.isFinite(w.width) && w.width > 0, `${w.id}: sane width`);
    if (w.id !== "t4") assert.equal(w.width, ts.MIN_TAB_WIDTH, "floored, not vanished");
  }
  assert.ok(widths.find((x) => x.id === "t4")!.width >= ts.MIN_TAB_WIDTH, "the focused tab stays readable");
});

test("deterministic, and single/empty inputs are sane", async () => {
  const ts = await load();
  assert.ok(ts, "tabStrip module must exist (see constants test)");
  const input = { stripWidth: 500, tabs: tabs3(2) };
  assert.deepEqual(ts.layoutTabStrip(input), ts.layoutTabStrip(input), "no jitter between renders");

  const single = ts.layoutTabStrip({ stripWidth: 900, tabs: [{ id: "only", naturalWidth: 200, active: true }] });
  assert.equal(single.length, 1);
  assert.equal(single[0].width, ts.STANDARD_TAB_WIDTH, "a lone roomy tab is standard width, not the whole strip");

  assert.deepEqual(ts.layoutTabStrip({ stripWidth: 500, tabs: [] }), [], "no tabs → no widths");
  assert.equal(ts.isStripOvercrowded([], 500), false);
});
