import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* SPEC-TESTS for sidebar double-click rename — https://github.com/roowus/truss/issues/147
   ("In the sidebar, sessions and remote hosts: double-click to rename,
   typing right there"). These FAIL on purpose today.

   Today: session rows' double-click opens the daily-driver layout
   (Sidebar.tsx:247 — `openDailyDriver`); host rows have no double-click;
   shell rows rename via the hover pencil only (#29). The ask: the
   file-manager gesture — double-click the row's name → inline edit.

   The gesture conflict (must be resolved in the fix): session dblclick is
   spoken for. The contract moves "open chat + trajectory + context" into
   the row's action cluster (it survives as an explicit action) so the
   name's double-click can mean rename.

   The contract:

   1. src/lib/rowRename.ts —

        rowRenameTarget(row: { kind: "session" | "host" | "terminal" | string; id: string }):
          { kind: "session" | "host" | "terminal"; id: string } | null

      sessions/hosts/shells rename; anything else (section headers…) null.

   2. rowActions.ts sessionRowActions gains the daily-driver entry
      (id "open-all") for openable chat rows — the displaced gesture lives
      on explicitly;

   3. read-through: Sidebar.tsx row titles carry onDoubleClick → inline
      edit, and the row-level openDailyDriver dblclick is gone. */

interface RowRenameModule {
  rowRenameTarget(row: { kind: string; id: string }): { kind: "session" | "host" | "terminal"; id: string } | null;
}

async function load(): Promise<RowRenameModule | null> {
  const spec = "../src/lib/rowRename"; // variable specifier: typechecks before the module exists
  return import(spec).catch(() => null);
}

test("src/lib/rowRename.ts exists", async () => {
  const mod = await load();
  assert.ok(mod, "src/lib/rowRename.ts must export rowRenameTarget — see issue #147");
});

test("the target matrix: sessions, hosts, shells rename; everything else null", async () => {
  const mod = await load();
  assert.ok(mod, "rowRename module must exist (see module test)");

  assert.deepEqual(mod.rowRenameTarget({ kind: "session", id: "s1" }), { kind: "session", id: "s1" });
  assert.deepEqual(mod.rowRenameTarget({ kind: "host", id: "h1" }), { kind: "host", id: "h1" });
  assert.deepEqual(mod.rowRenameTarget({ kind: "terminal", id: "t1" }), { kind: "terminal", id: "t1" });
  assert.equal(mod.rowRenameTarget({ kind: "section", id: "x" }), null, "section headers don't rename");
  assert.equal(mod.rowRenameTarget({ kind: "session", id: "" }), null, "no id, no rename");
  assert.doesNotThrow(() => mod.rowRenameTarget({ kind: "mystery", id: "z" }));
});

test("the displaced gesture survives: session rows gain an explicit open-all action", async () => {
  const ra: any = await import("../src/lib/rowActions.js");
  assert.equal(typeof ra.sessionRowActions, "function", "sessionRowActions exists (#110)");
  const acts = ra.sessionRowActions({ pinned: false });
  assert.ok(
    acts.some((a: { id: string }) => a.id === "open-all"),
    "double-click's old job (chat + trajectory + context) moves into the row actions — the gesture is never lost (issue #147's conflict resolution)",
  );
});

test("read-through: row titles double-click into inline edit; the row's dblclick no longer opens the daily driver", () => {
  const src = readFileSync(new URL("../src/components/Sidebar.tsx", import.meta.url), "utf8");
  assert.ok(!/onDoubleClick=\{openable \? \(\) => openDailyDriver/.test(src), "the row-level dblclick → daily-driver is retired (the title takes rename)");
  assert.ok(/onDoubleClick/.test(src) && /rename/i.test(src), "the title span carries the rename gesture");
  /* audit round 2 (M1): pin the round-1 B2 fix — the host rename targets
     the shared label, never the per-user alias (alias || h.label here was
     exactly the bug) */
  assert.ok(/setName\(h\.label\)/.test(src), "the host rename prefills the shared label, never the alias (round-1 B2)");
  assert.ok(!/setName\(alias \|\| h\.label\)/.test(src), "the alias text must not land in the shared label (round-1 B2)");
});
