import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* Regression pin for the resting row's right-edge gap —
   https://github.com/roowus/truss/issues/140
   ("The timestamp + state indicator on a sidebar session row sits too far
   from the right edge — a big gap; shift everything to the edge"). These
   failed 4/4 while the fix was missing and now pin the contract it must
   keep satisfying.

   Why (investigated, Sidebar.tsx SessionRow): the action cluster is `flex`
   at REST whenever the row isn't trash — and the unpinned pin keeps its slot
   via opacity-0 ("keeps its slot and stays tabbable"), so the resting row
   carries an invisible ~24px button between the timestamp cluster and the
   row's right edge. The code even handles this for trash view ("no
   always-slotted member → the container hides until hover") but not for the
   unpinned case.

   The contract (rowActions.ts, extends #110's sessionRowActions):

     clusterRestState(acts): {
       cls: "flex" | "hidden group-hover:flex";   // the cluster at rest
       resting: RowAction[];                       // which members take space at rest
     }

   - a cluster with NO always-visible member rests hidden (hover-only) —
     nothing reserves space: the timestamp+dot sit at the true right edge;
   - a pinned row's cluster rests visible with ONLY the pin in it (solid);
   - hover members take ZERO layout space at rest (no opacity slot-keeping);
   - on hover the full cluster appears as today (#110's one-gap rule intact). */

interface RowActionsRestModule {
  sessionRowActions(state: { pinned: boolean; archived?: boolean; dead?: boolean; trashView?: boolean }): { id: string; visible: "always" | "hover" }[];
  clusterRestState(acts: { id: string; visible: "always" | "hover" }[]): {
    cls: string;
    resting: { id: string }[];
  };
}

async function load(): Promise<RowActionsRestModule | null> {
  const spec = "../src/lib/rowActions"; // the module exists; the export is the contract
  const mod: any = await import(spec);
  return typeof mod?.clusterRestState === "function" ? mod : null;
}

test("rowActions exports clusterRestState", async () => {
  const mod = await load();
  assert.ok(mod, "src/lib/rowActions.ts must export clusterRestState — see issue #140");
});

test("unpinned at rest: the cluster hides wholesale — no phantom 24px pin slot", async () => {
  const mod = await load();
  assert.ok(mod, "clusterRestState must exist (see module test)");

  const unpinned = mod.clusterRestState(mod.sessionRowActions({ pinned: false }));
  assert.match(unpinned.cls, /hidden\s+group-hover:flex/, "rest hidden, hover reveals (the timestamp+dot reach the edge)");
  assert.deepEqual(unpinned.resting, [], "NOTHING takes layout space at rest — no invisible member keeps a slot");
});

test("pinned at rest: the cluster rests visible with ONLY the solid pin", async () => {
  const mod = await load();
  assert.ok(mod, "clusterRestState must exist (see module test)");

  const pinned = mod.clusterRestState(mod.sessionRowActions({ pinned: true }));
  assert.ok(!/hidden/.test(pinned.cls), "pinned rows show their pin at rest");
  assert.deepEqual(pinned.resting.map((a) => a.id), ["pin"], "only the pin rests; the other actions wait for hover");
});

test("read-through: the session row's resting cluster uses the contract — no opacity slot-keeping for unpinned pins", () => {
  const src = readFileSync(new URL("../src/components/Sidebar.tsx", import.meta.url), "utf8");
  assert.ok(/clusterRestState\(/.test(src), "the resting cluster must come from clusterRestState");
  /* pin the REAL markup, scoped to SessionRow (shell/host rows keep their
     #86 opacity rule on purpose): the container renders rest.cls, and the
     row carries neither the opacity-0 slot-keeping nor pinVisibilityCls —
     those two together were the phantom 24px */
  const row = src
    .slice(src.indexOf("function SessionRow"), src.indexOf("\nfunction ", src.indexOf("function SessionRow") + 1))
    .replace(/\/\*[\s\S]*?\*\//g, ""); /* prose may name the old hack; the pin is on the markup */
  assert.ok(/cn\("items-center shrink-0", rest\.cls/.test(row), "the cluster container must render clusterRestState's cls");
  assert.ok(!/opacity-0|pinVisibilityCls/.test(row), "SessionRow must not keep an invisible member's slot — zero layout space at rest");
});
