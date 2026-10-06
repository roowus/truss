import { test } from "node:test";
import assert from "node:assert/strict";

/* SPEC-TESTS for the clipped chat header — https://github.com/roowus/truss/issues/3
   ("Chat header: right-side controls get cut off"). These pin the contract
   the issue demanded; the fix landed with them, so they pass.

   The bug: ChatHeader (apps/web/src/panels/ChatPanel.tsx:88-119) is a single
   no-wrap flex row whose only flexible item is the title. The right cluster —
   model Select (w-[170px] shrink-0), Stop, Trajectory, ⋯ menu — is pinned
   wider than narrow chat panels, and dockview clips the overflow
   (overflow:hidden, index.css), so the rightmost controls get cut off and
   become unreachable.

   The contract: a pure planner, src/lib/headerFit.ts

     planHeaderFit(items, available, { triggerWidth, gap })
       items:         { id: string; width: number; essential?: boolean }[]
                      in display order (left → right)
       available:     pixel width the cluster may occupy (≥ 0)
       triggerWidth:  width to reserve for the overflow trigger when (and only
                      when) at least one item collapses into it
       gap:           px between rendered items (and before the trigger)
     → { visible: string[]; overflow: string[]; needsMore: boolean }
       (lists in display order; needsMore = anything collapsed — the ⋯
       trigger's render rule, issue #145)

   Rules it must honor:
   - an item whose footprint fits stays visible; collapsing is rightmost-first
     among non-essential items (the edge that's clipped today);
   - essential items (Stop; the menu trigger) NEVER collapse, even at width 0;
   - the rendered footprint — sum(visible widths) + gaps + trigger when
     overflowed — never exceeds `available` unless only essentials remain;
   - no item is ever lost or duplicated;
   - pure + deterministic (same args → same plan, no RNG/clock).

   Component wiring (ResizeObserver on the header, collapsed items render
   inside the ⋯ menu) is covered by the issue's acceptance criteria, not here. */

interface HeaderItem {
  id: string;
  width: number;
  essential?: boolean;
}
interface HeaderFitPlan {
  visible: string[];
  overflow: string[];
  needsMore: boolean;
}
type PlanFn = (items: HeaderItem[], available: number, opts: { triggerWidth: number; gap: number }) => HeaderFitPlan;

async function loadPlanner(): Promise<PlanFn | null> {
  const spec = "../src/lib/headerFit"; // variable specifier: typechecks even before the module exists
  const mod: any = await import(spec).catch(() => null);
  return typeof mod?.planHeaderFit === "function" ? mod.planHeaderFit : null;
}

/* the chat header's right cluster, as rendered today — the panel shortcuts
   (context, team, skills) joined as regular items in issue #145 */
const CLUSTER: HeaderItem[] = [
  { id: "select", width: 170 },
  { id: "stop", width: 58, essential: true }, // safety: interrupt must stay reachable
  { id: "trajectory", width: 28 },
  { id: "context", width: 28 },
  { id: "team", width: 28 },
  { id: "skills", width: 28 },
  { id: "more", width: 28, essential: true }, // the ⋯ menu IS the overflow trigger's home
];
const GAP = 6;
const TRIGGER = 28;

function footprint(plan: HeaderFitPlan, items: HeaderItem[]): number {
  const w = (id: string) => items.find((i) => i.id === id)!.width;
  const vis = plan.visible.reduce((a, id) => a + w(id), 0) + GAP * Math.max(0, plan.visible.length - 1);
  return plan.overflow.length ? vis + (plan.visible.length ? GAP : 0) + TRIGGER : vis;
}

function assertSound(plan: HeaderFitPlan, items: HeaderItem[], available: number) {
  const ids = items.map((i) => i.id);
  const all = [...plan.visible, ...plan.overflow];
  assert.deepEqual([...all].sort(), [...ids].sort(), `width ${available}: every item exactly once — none lost, none duplicated`);
  assert.equal(new Set(all).size, items.length, `width ${available}: no duplicates`);

  for (const it of items.filter((i) => i.essential)) {
    assert.ok(plan.visible.includes(it.id), `width ${available}: essential ${it.id} never collapses`);
    assert.ok(!plan.overflow.includes(it.id));
  }

  /* monotone, rightmost-first: within the collapsible subsequence the
     overflowed ones form a SUFFIX (no reordering holes) */
  const collapsible = items.filter((i) => !i.essential).map((i) => i.id);
  const first = collapsible.findIndex((id) => plan.overflow.includes(id));
  if (first !== -1) {
    for (const id of collapsible.slice(first)) {
      assert.ok(plan.overflow.includes(id), `width ${available}: ${id} must collapse once something to its left did (rightmost-first)`);
    }
    for (const id of collapsible.slice(0, first)) {
      assert.ok(plan.visible.includes(id), `width ${available}: ${id} stays visible while something to its right is`);
    }
  }

  const onlyEssentials = plan.visible.every((id) => items.find((i) => i.id === id)!.essential);
  assert.ok(
    footprint(plan, items) <= available || onlyEssentials,
    `width ${available}: footprint ${footprint(plan, items)} must fit (unless only essentials remain)`,
  );
}

test("headerFit module exists and exports planHeaderFit", async () => {
  const plan = await loadPlanner();
  assert.ok(plan, "src/lib/headerFit.ts must export planHeaderFit(items, available, opts) — see issue #3");
});

test("plenty of room: everything visible, no overflow, no trigger reserved", async () => {
  const plan = await loadPlanner();
  assert.ok(plan, "planHeaderFit must exist (see module test)");
  const p = plan(CLUSTER, 800, { triggerWidth: TRIGGER, gap: GAP });
  assert.deepEqual(p, { visible: ["select", "stop", "trajectory", "context", "team", "skills", "more"], overflow: [], needsMore: false });
  assert.ok(footprint(p, CLUSTER) <= 800);
});

test("the reported geometry: ~380px chat panel → the collapsibles overflow rightmost-first, essentials stay", async () => {
  const plan = await loadPlanner();
  assert.ok(plan, "planHeaderFit must exist (see module test)");
  /* panel ≈ 380px; the left cluster (mark 18 + device chip ≈ 96 + state ≈ 46
     + padding/gaps ≈ 48) leaves ≈ 172px for the right cluster — the fuller
     post-#145 cluster collapses to its essentials there */
  const p = plan(CLUSTER, 172, { triggerWidth: TRIGGER, gap: GAP });
  assert.deepEqual(p.visible, ["stop", "more"], "essentials remain reachable");
  assert.deepEqual(p.overflow, ["select", "trajectory", "context", "team", "skills"], "collapses move into the ⋯ menu, in display order");
  assert.equal(p.needsMore, true, "the menu has contents → the ⋯ trigger shows");
  assert.ok(footprint(p, CLUSTER) <= 172, "the clipped right end is gone by construction");
});

test("zero width: essentials stay, everything else overflows, nothing crashes", async () => {
  const plan = await loadPlanner();
  assert.ok(plan, "planHeaderFit must exist (see module test)");
  const p = plan(CLUSTER, 0, { triggerWidth: TRIGGER, gap: GAP });
  assert.deepEqual(p.visible, ["stop", "more"]);
  assert.deepEqual(p.overflow, ["select", "trajectory", "context", "team", "skills"]);
});

test("empty cluster is a valid plan", async () => {
  const plan = await loadPlanner();
  assert.ok(plan, "planHeaderFit must exist (see module test)");
  assert.deepEqual(plan([], 200, { triggerWidth: TRIGGER, gap: GAP }), { visible: [], overflow: [], needsMore: false });
});

test("pure and deterministic: same inputs → identical plans", async () => {
  const plan = await loadPlanner();
  assert.ok(plan, "planHeaderFit must exist (see module test)");
  const a = plan(CLUSTER, 250, { triggerWidth: TRIGGER, gap: GAP });
  const b = plan(CLUSTER, 250, { triggerWidth: TRIGGER, gap: GAP });
  assert.deepEqual(a, b, "no RNG, no clock — a toolbar must not flicker between renders");
});

test("invariant fuzz: at EVERY width the plan is sound (never clipped, never lost)", async () => {
  const plan = await loadPlanner();
  assert.ok(plan, "planHeaderFit must exist (see module test)");
  for (let avail = 0; avail <= 640; avail += 7) {
    assertSound(plan(CLUSTER, avail, { triggerWidth: TRIGGER, gap: GAP }), CLUSTER, avail);
  }
});

test("collapse order is stable across the shrink sweep (no oscillation)", async () => {
  const plan = await loadPlanner();
  assert.ok(plan, "planHeaderFit must exist (see module test)");
  /* as width shrinks, the overflow set only ever GROWS — it never gives an
     item back before a wider width is reached (that would thrash the UI) */
  let prevOverflow: string[] = [];
  for (let avail = 640; avail >= 0; avail -= 13) {
    const p = plan(CLUSTER, avail, { triggerWidth: TRIGGER, gap: GAP });
    for (const id of prevOverflow) {
      assert.ok(p.overflow.includes(id), `width ${avail}: ${id} un-collapsed while still shrinking`);
    }
    prevOverflow = p.overflow;
  }
});

/* WIRING PINS — the planner is only as true as the geometry its one caller
   feeds it. ChatPanel builds its items from HEADER_CLUSTER (src/lib/headerFit)
   rather than re-declaring widths by hand; these tests keep that shared copy
   and this spec cluster from drifting apart, and pin the trigger accounting
   the caller relies on. */

test("the wiring's exported geometry still matches the spec cluster", async () => {
  const { HEADER_CLUSTER, HEADER_GAP } = await import("../src/lib/headerFit");
  assert.deepEqual(HEADER_CLUSTER, CLUSTER, "ChatPanel's cluster drifted from the spec cluster — move both together");
  assert.equal(HEADER_GAP, GAP, "ChatPanel's gap drifted from the spec gap");
});

test("the ⋯ trigger is priced once: widths that truly fit keep everything inline", async () => {
  const plan = await loadPlanner();
  assert.ok(plan, "planHeaderFit must exist (see module test)");
  /* ChatPanel renders the ⋯ trigger on every plan and reserves triggerWidth 0
     for it. Reserving it twice (the essential `more` item AND the trigger)
     left the footprint unchanged when an item collapsed, so widths that
     truly fit pushed items into the menu ~28px early. The full cluster is
     368px of items + 36px of gaps = 404. */
  const p = plan(CLUSTER, 404, { triggerWidth: 0, gap: GAP });
  assert.deepEqual(p.overflow, [], "the exact fit collapses nothing");
  assert.equal(p.needsMore, false, "nothing overflowed → needsMore says so");
  const q = plan(CLUSTER, 403, { triggerWidth: 0, gap: GAP });
  assert.deepEqual(q.overflow, ["skills"], "the first 1px shortfall collapses the rightmost shortcut only");
  assert.equal(q.needsMore, true);
});
