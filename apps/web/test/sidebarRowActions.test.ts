import { test } from "node:test";
import assert from "node:assert/strict";

/* SPEC-TESTS for sidebar row delete affordances —
   https://github.com/roowus/truss/issues/85
   ("Allow me to delete hosts and shells from the sidebar"). These FAIL on
   purpose today: they pin the contract a fix must satisfy.

   Today: shell rows hide a hover-only kill x (Sidebar.tsx:159-168 —
   discoverable only by accident), and host rows have NOTHING (the only
   delete lives two panels deep in the Host details page). The sessions rows
   already have the pattern: visible-on-hover actions with a two-click
   confirm for destructive ones.

   The contract: one descriptor source — src/lib/rowActions.ts —

     shellRowActions(shell): RowAction[]   // { id, label, icon, dangerous?, confirm? }
     hostRowActions(host): RowAction[]

   - every row: "open" first, destructive last;
   - shells: open · rename (#31) · kill — kill is dangerous + confirm:true
     (two-click, like the session rows); an EXITED shell's destructive
     action reads "remove" (it's already dead — nothing to kill);
   - hosts: open · delete — dangerous + confirm:true, available online AND
     offline (an offline box is exactly the one you want gone);
   - every action has a non-empty label (tooltips per #25's rule). */

interface RowAction {
  id: string;
  label: string;
  icon?: string;
  dangerous?: boolean;
  confirm?: boolean;
}
interface RowActionsModule {
  shellRowActions(shell: { id: string; alive?: boolean }): RowAction[];
  hostRowActions(host: { id: string; online?: boolean; revoked?: boolean }): RowAction[];
}

async function load(): Promise<RowActionsModule | null> {
  const spec = "../src/lib/rowActions"; // variable specifier: typechecks before the module exists
  return import(spec).catch(() => null);
}

function checkShape(actions: RowAction[], ctx: string) {
  assert.ok(actions.length >= 2, `${ctx}: more than one action`);
  assert.equal(actions[0].id, "open", `${ctx}: open first`);
  const last = actions.at(-1)!;
  assert.equal(last.dangerous, true, `${ctx}: destructive last`);
  assert.equal(last.confirm, true, `${ctx}: destructive gets the two-click confirm (the session-row rule)`);
  for (const a of actions) assert.ok(a.label.trim().length > 0, `${ctx}: ${a.id} has a label`);
}

test("src/lib/rowActions.ts exists", async () => {
  const mod = await load();
  assert.ok(mod, "src/lib/rowActions.ts must export shellRowActions/hostRowActions — see issue #85");
});

test("shell rows: open · rename · kill, with kill confirmed; exited shells get remove", async () => {
  const mod = await load();
  assert.ok(mod, "rowActions module must exist (see module test)");

  const live = mod.shellRowActions({ id: "s1", alive: true });
  checkShape(live, "live shell");
  assert.deepEqual(live.map((a) => a.id), ["open", "rename", "kill"], "the trio in order");
  assert.match(live.at(-1)!.label, /kill/i);

  const dead = mod.shellRowActions({ id: "s2", alive: false });
  assert.match(dead.at(-1)!.label, /remove|clear|delete/i, "a dead shell is removed, not 'killed'");
});

test("host rows: open · delete, confirmed, online or offline", async () => {
  const mod = await load();
  assert.ok(mod, "rowActions module must exist (see module test)");

  for (const online of [true, false]) {
    const actions = mod.hostRowActions({ id: "h1", online });
    checkShape(actions, `host online=${online}`);
    assert.deepEqual(actions.map((a) => a.id), ["open", "delete"], "open then delete");
    assert.match(actions.at(-1)!.label, /delete|remove/i);
  }
  const revoked = mod.hostRowActions({ id: "h2", revoked: true });
  assert.equal(revoked.at(-1)!.id, "delete", "a revoked host is still deletable");
});
