import { test } from "node:test";
import assert from "node:assert/strict";

/* SPEC-TESTS for flattening the ⋯ "More panels" menu into the header —
   https://github.com/roowus/truss/issues/145
   ("Every option under the three dots should just go in the top bar next to
   trajectory — we don't have that many; the menu is inconsistent"). They
   pinned the contract while red; the fix landed with them, so they pass.

   Before: trajectory was the only inline panel shortcut; the rest (Context
   usage, Subagent team, Skills) hid in the ⋯ menu — and the ⋯ trigger
   rendered ALWAYS (HEADER_CLUSTER marks it essential).

   The contract (headerFit.ts — the planner stays the engine):
   - HEADER_CLUSTER carries the panel shortcuts as regular items
     (trajectory, context, skills, shell — "team" joins capability-gated
     in the panel code);
   - a roomy header inlines ALL of them;
   - a narrow header still collapses overflow into ⋯ (the planner's whole
     point — no new behavior);
   - the planner reports needsMore (overflow non-empty) so the ⋯ trigger
     never has to render as an empty button. ChatPanel keeps the trigger
     unconditional: its menu always carries the utility block (copy
     reference, resume, the id dump) — developer call, option A on the
     issue. (Shell joined the top bar too, on the developer's follow-up.) */

interface HeaderFitModule {
  HEADER_GAP: number;
  HEADER_CLUSTER: { id: string; width: number; essential?: boolean }[];
  planHeaderFit(items: { id: string; width: number; essential?: boolean }[], available: number, opts: { triggerWidth: number; gap: number }): { visible: string[]; overflow: string[] };
}

async function load(): Promise<HeaderFitModule> {
  const mod: any = await import("../src/lib/headerFit.js");
  return mod;
}

test("the panel shortcuts join the header cluster", async () => {
  const mod = await load();
  const ids = mod.HEADER_CLUSTER.map((i) => i.id);
  for (const id of ["trajectory", "context", "skills", "shell"]) {
    assert.ok(ids.includes(id), `HEADER_CLUSTER must carry "${id}" inline — today it hides under ⋯ (issue #145)`);
  }
});

test("a roomy header inlines everything; narrow collapses (the planner's contract holds)", async () => {
  const mod = await load();
  const wide = mod.planHeaderFit(mod.HEADER_CLUSTER, 600, { triggerWidth: 0, gap: mod.HEADER_GAP });
  assert.deepEqual(wide.overflow, [], "roomy → everything inline, nothing in the menu");

  const narrow = mod.planHeaderFit(mod.HEADER_CLUSTER, 90, { triggerWidth: 0, gap: mod.HEADER_GAP });
  assert.ok(narrow.overflow.length > 0, "narrow → the extras collapse (unchanged behavior)");
  assert.ok(narrow.visible.length > 0, "and the essentials stay");
});

test("no empty ⋯: the trigger exists only when overflow does", async () => {
  const mod = await load();
  /* the planner must tell the truth about whether a menu is warranted */
  const wide = mod.planHeaderFit(mod.HEADER_CLUSTER, 600, { triggerWidth: 0, gap: mod.HEADER_GAP });
  const withMore = wide as { needsMore?: boolean };
  assert.equal(typeof withMore.needsMore, "boolean", "planHeaderFit reports needsMore (the ⋯ trigger's render rule)");
  assert.equal(withMore.needsMore, false, "everything fits → no ⋯ button");
  const narrow = mod.planHeaderFit(mod.HEADER_CLUSTER, 90, { triggerWidth: 0, gap: mod.HEADER_GAP }) as { needsMore?: boolean };
  assert.equal(narrow.needsMore, true, "overflow → the ⋯ appears");
});
