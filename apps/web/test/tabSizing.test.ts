import { test } from "node:test";
import assert from "node:assert/strict";

/* SPEC-TESTS for rebuilding the tab size manager —
   https://github.com/roowus/truss/issues/34
   ("Tab sizing often breaks, and a reload fixes it — redo the whole thing").
   These FAIL on purpose today: they pin the contract a fix must satisfy.

   Today's manager is imperative and stateful in fragile places
   (Workspace.tsx's TrussTab measure()):
   - observers hold element references across dockview re-renders — when a
     tab shell/strip element is replaced (moves, restores, remounts), the
     observers keep watching the detached node and the verdict/widths go
     stale until a full reload (which remounts everything);
   - the hysteresis wiring is crossed: `setUltra(prev => crampedVerdict(prev…))`
     feeds the ULTRA history into the CRAMPED verdict — the two verdicts
     contaminate each other;
   - probes read 0px before first layout (restore race), and nothing
     re-derives until an RO tick.

   The contract: the whole sizing decision becomes ONE pure, idempotent,
   self-healing function — src/lib/tabSizing.ts —

     computeTabStrip({
       stripWidth,
       tabs: [{ id, naturalWidth, active, prevCramped?, prevUltra? }],
     }) → {
       widths: Record<string, number>;   // every input id, finite > 0
       cramped: boolean;                  // strip verdict (sticky, #21)
       ultra:   boolean;                  // for the CALLER's tab — hmm, see note
     }

   …except ultra is per-tab, so the honest shape is:

     computeTabStrip(input) → { widths, verdicts: Record<id, {cramped, ultra}> }

   Rules it must honor:
   - SELF-HEALING: with prev* omitted (a fresh mount, a missed measurement, a
     restored layout), one call converges to the same widths/verdicts as the
     steady state — any broken frame corrects itself on the next measure,
     which is exactly the property "reload fixes it" had been providing by
     hand;
   - idempotent + total: same inputs → identical outputs; every input tab id
     appears in widths with a finite positive number; zero/NaN/missing
     natural widths (probe not laid out yet) degrade to the standard width,
     never to NaN;
   - composed, not rewritten: widths follow #23's layoutTabStrip rules
     (uniform roomy, focused-fully-shown, uniform inactive compression),
     verdicts follow #21's sticky rules, and each tab's ultra reads THIS
     pass's cramped verdict — never its own history;
   - the active tab always reports cramped=false (#23: it never compresses).

   The component side (re-resolving element targets per event, applying
   widths idempotently) is acceptance criteria, not pinned here. */

interface TabInput {
  id: string;
  naturalWidth: number;
  active: boolean;
  prevCramped?: boolean;
  prevUltra?: boolean;
}
interface StripResult {
  widths: Record<string, number>;
  verdicts: Record<string, { cramped: boolean; ultra: boolean }>;
}
interface TabSizingModule {
  computeTabStrip(input: { stripWidth: number; tabs: TabInput[] }): StripResult;
}

async function load(): Promise<TabSizingModule | null> {
  const spec = "../src/lib/tabSizing"; // variable specifier: typechecks even before the module exists
  return import(spec).catch(() => null);
}

const TABS: TabInput[] = [
  { id: "a", naturalWidth: 132, active: true },
  { id: "b", naturalWidth: 208, active: false },
  { id: "c", naturalWidth: 96, active: false },
];

test("src/lib/tabSizing.ts exists — one pure function owns the whole decision", async () => {
  const mod = await load();
  assert.ok(mod, "src/lib/tabSizing.ts must export computeTabStrip — see issue #34");
});

test("self-healing: a fresh mount (no prev state) converges to the steady state in ONE pass", async () => {
  const mod = await load();
  assert.ok(mod, "tabSizing module must exist (see module test)");

  const strip = 700; // crowded for these tabs
  const fresh = mod.computeTabStrip({ stripWidth: strip, tabs: TABS });
  /* feed the answer back in as prev state — the steady state must be a fixed point */
  const again = mod.computeTabStrip({
    stripWidth: strip,
    tabs: TABS.map((t) => ({
      ...t,
      prevCramped: fresh.verdicts[t.id].cramped,
      prevUltra: fresh.verdicts[t.id].ultra,
    })),
  });
  assert.deepEqual(again, fresh, "steady state is a fixed point — no reload needed, the next measure self-corrects");
});

test("idempotent + total: every id gets a finite positive width; same inputs → identical output", async () => {
  const mod = await load();
  assert.ok(mod, "tabSizing module must exist (see module test)");
  const input = { stripWidth: 640, tabs: TABS };
  const a = mod.computeTabStrip(input);
  const b = mod.computeTabStrip(input);
  assert.deepEqual(a, b, "no hidden state beyond the explicit prev inputs");
  for (const t of TABS) {
    assert.ok(Number.isFinite(a.widths[t.id]) && a.widths[t.id] > 0, `${t.id}: finite positive width`);
    assert.ok(a.verdicts[t.id], `${t.id}: a verdict`);
  }
});

test("degenerate measurements never poison the strip (0/NaN natural widths → standard, not NaN)", async () => {
  const mod = await load();
  assert.ok(mod, "tabSizing module must exist (see module test)");
  const out = mod.computeTabStrip({
    stripWidth: 500,
    tabs: [
      { id: "x", naturalWidth: 0, active: true }, // probe not laid out yet (the restore race)
      { id: "y", naturalWidth: Number.NaN, active: false },
    ],
  });
  assert.ok(Number.isFinite(out.widths.x) && out.widths.x > 0, "x survived a 0px probe");
  assert.ok(Number.isFinite(out.widths.y) && out.widths.y > 0, "y survived a NaN probe");
  assert.equal(typeof out.verdicts.x.cramped, "boolean");
  assert.equal(typeof out.verdicts.y.ultra, "boolean");
});

test("rules composition: #23 widths, #21 sticky verdicts, active never cramped, ultra reads THIS pass", async () => {
  const mod = await load();
  assert.ok(mod, "tabSizing module must exist (see module test)");

  const strip = 400; // crowded: 3 × standard ≫ 400
  const out = mod.computeTabStrip({ stripWidth: strip, tabs: TABS });

  assert.equal(out.verdicts.a.cramped, false, "the active tab is never cramped (#23: it's fully displayed)");
  assert.ok(out.widths.a >= out.widths.b && out.widths.a >= out.widths.c, "active is widest");
  assert.equal(out.widths.b, out.widths.c, "inactives compress uniformly (#23)");
  assert.equal(out.verdicts.b.cramped, true, "inactives report the strip's crowding");
  assert.equal(out.verdicts.b.ultra, out.widths.b < 64, "ultra reads THIS pass's cramped + this pass's width — not stale history");

  /* the crossed-wiring probe: an inactive tab whose PREV ultra was true must
     not make its cramped verdict sticky-wrong (today's setUltra(prev =>
     crampedVerdict(prev…)) bug feeds ultra's history into cramped) */
  const contaminated = mod.computeTabStrip({
    stripWidth: 900, // roomy
    tabs: TABS.map((t) => ({ ...t, prevUltra: true })),
  });
  assert.equal(contaminated.verdicts.b.cramped, false, "a stale ultra=true must not drag cramped up with it");
});
