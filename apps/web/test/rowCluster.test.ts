import { test } from "node:test";
import assert from "node:assert/strict";

/* SPEC-TESTS for one action cluster per row — https://github.com/roowus/truss/issues/110
   ("In the sidebar the pin button sits a different gap from the other
   buttons than they are from each other"). These FAIL on purpose today.

   Why it happens (investigated): the session row renders the pin as its OWN
   element in the row flow (after the title, row-level gap-2, with the
   badge/timestamp spans in between — Sidebar.tsx) while every other action
   lives in the separate far-right hover cluster — so pin↔actions spacing is
   the row gap, actions↔actions spacing is the cluster's, and they never
   match. Shell/host rows already compose actions from ONE descriptor array
   (rowActions.ts, #85); session rows stayed bespoke.

   The contract: session rows compose the same way — extend src/lib/rowActions.ts —

     sessionRowActions(state: {
       pinned: boolean; archived?: boolean; dead?: boolean; trashView?: boolean;
     }): RowAction[]

   where RowAction = { id, icon, label, danger?, visible: "always" | "hover" }.

   Structural pins (the gap can't diverge when there's one array, one flex
   container, one gap):
   - EXACTLY ONE pin entry, LAST in the cluster (amended by issue #156: the
     pin anchors the right edge — identical index at rest and on hover, so
     it can never dodge the pointer);
   - the pin is the ONLY entry that may be visible: "always" — and iff pinned;
   - destructive entries ride last-AMONG-THE-REST (amended by issue #156:
     the pin owns the right edge, so trash never sits under a cursor aimed
     at the pin);
   - the badge/timestamp never interleave with actions (they're not actions —
     they don't belong in the array at all). */

interface RowAction {
  id: string;
  icon: string;
  label: string;
  danger?: boolean;
  confirm?: boolean; // branch pins below assert the two-click gate (audit round 2)
  visible: "always" | "hover";
}
interface RowActionsModule {
  sessionRowActions(state: { pinned: boolean; archived?: boolean; dead?: boolean; trashView?: boolean }): RowAction[];
}

async function load(): Promise<RowActionsModule | null> {
  const spec = "../src/lib/rowActions"; // the module exists; the export is the contract
  const mod: any = await import(spec);
  return typeof mod?.sessionRowActions === "function" ? mod : null;
}

test("rowActions exports sessionRowActions — one cluster, one gap", async () => {
  const mod = await load();
  assert.ok(mod, "src/lib/rowActions.ts must export sessionRowActions — the pin joins the same cluster as every other action, so one gap rules them all (issue #110)");
});

test("exactly one pin, LAST (the stable right-edge anchor), and the only always-visible member — iff pinned", async () => {
  /* AMENDED (issue #156): the #110 contract led with the pin — on hover the
     pin jumped left and the trash landed under the cursor (the user's exact
     report). The pin anchors RIGHTMOST, the same index at rest and on
     hover — a pinned row's solid pin never dodges the pointer. */
  const mod = await load();
  assert.ok(mod, "sessionRowActions must exist (see module test)");

  for (const pinned of [true, false]) {
    const acts = mod.sessionRowActions({ pinned });
    const pins = acts.filter((a) => a.id === "pin");
    assert.equal(pins.length, 1, "exactly one pin entry");
    assert.equal(acts.at(-1)!.id, "pin", "the pin anchors the RIGHT edge — identical index at rest and on hover, so it never dodges (issue #156)");
    assert.equal(pins[0].visible, pinned ? "always" : "hover", "pinned shows always; unpinned only on hover");
    for (const a of acts.filter((x) => x.id !== "pin")) {
      assert.equal(a.visible, "hover", `${a.id} is hover-only — no second always-on glyph sneaks back`);
    }
    assert.ok(acts.every((a) => typeof a.icon === "string" && a.icon.length > 0), "every entry carries an icon");
    assert.ok(acts.every((a) => typeof a.label === "string" && a.label.length > 0), "every entry carries a label");
  }
});

test("destructive last (the #85 rule stands); badge/timestamps are NOT actions", async () => {
  const mod = await load();
  assert.ok(mod, "sessionRowActions must exist (see module test)");

  const acts = mod.sessionRowActions({ pinned: false });
  const dangerIdx = acts.findIndex((a) => a.danger);
  assert.ok(dangerIdx >= 0, "a destructive action exists (trash)");
  /* AMENDED (issue #156): the pin owns the right edge now, so destructive
     rides last-AMONG-THE-REST — never under a cursor aimed at the pin */
  assert.equal(dangerIdx, acts.length - 2, "destructive rides just inside the pin anchor — never at the edge where the pin lives");

  assert.ok(!acts.some((a) => /badge|permission|timestamp|ago|state/i.test(a.id)), "indicators aren't actions — they don't sit in the cluster");
});

/* ---- branch pins (added in PR #117 audit round 1) -------------------------
   The contract tests above only ever call sessionRowActions({ pinned }), so
   the remaining input space — trashView, archived, dead — is pinned here.
   The trash-view set matters most: it gates purgeSession, the row's only
   permanently destructive action, and a silent regression there would
   otherwise ship green. */

test("trash view: exactly restore + purge, no pin, purge last and confirmed", async () => {
  const mod = await load();
  assert.ok(mod, "sessionRowActions must exist (see module test)");

  for (const pinned of [true, false]) {
    const acts = mod.sessionRowActions({ pinned, trashView: true });
    assert.deepEqual(acts.map((a) => a.id), ["restore", "purge"], "trash rows offer exactly restore + purge — pin/close/archive don't apply to a session out of the live list");
    const purge = acts.at(-1)!;
    assert.equal(purge.danger, true, "purge is the destructive entry");
    assert.equal(purge.confirm, true, "purge keeps the two-click confirm — dropping it makes purge a one-click permanent delete");
    assert.ok(acts.every((a) => a.visible === "hover"), "no always-visible member in trash view, pinned or not");
  }
});

test("archived rows unarchive instead of shell/archive; dead rows drop close", async () => {
  const mod = await load();
  assert.ok(mod, "sessionRowActions must exist (see module test)");

  /* order pins updated for the #156 amendment: the pin anchors LAST (the
     stable right edge), destructive rides just inside it */
  const live = mod.sessionRowActions({ pinned: false });
  assert.deepEqual(live.map((a) => a.id), ["open-all", "shell", "archive", "close", "trash", "pin"], "the live row's full cluster");

  const dead = mod.sessionRowActions({ pinned: false, dead: true });
  assert.deepEqual(dead.map((a) => a.id), ["open-all", "shell", "archive", "trash", "pin"], "a dead session has no process left to stop — no close");

  const archived = mod.sessionRowActions({ pinned: false, archived: true });
  assert.deepEqual(archived.map((a) => a.id), ["open-all", "unarchive", "trash", "pin"], "an archived row restores, never re-archives");

  for (const [name, acts] of Object.entries({ live, dead, archived })) {
    assert.equal(acts.at(-1)!.id, "pin", `${name}: the pin anchors the right edge`);
    assert.equal(acts.at(-2)!.danger, true, `${name}: destructive rides just inside the pin anchor`);
    assert.equal(acts.at(-2)!.confirm, true, `${name}: the destructive entry keeps its two-click confirm (the #85 rule)`);
  }
});
