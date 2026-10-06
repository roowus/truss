import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* SPEC-TESTS for double-click tab rename — https://github.com/roowus/truss/issues/141
   ("Rename a shell or a harness chat by double-clicking the tab and typing —
   just like workspaces"). These FAIL on purpose today.

   The workspace strip already does exactly this (DesktopStrip.tsx:71 —
   onDoubleClick → beginRename → inline input in the tab). Panel tabs
   (Workspace.tsx) have no double-click at all (only middle-click close).

   The contract: a pure src/lib/tabRename.ts —

     tabRenameTarget(tab: { kind: string; sessionId?: string; terminalId?: string }):
       { kind: "session" | "terminal"; id: string } | null

   - chat tabs → rename the SESSION; terminal tabs → rename the TERMINAL;
   - anything else (feed, tasks, monitor…) → null (not renamable);
   - missing ids → null, never throws;
   and cleanTabTitle(input): trimmed, ≤64, empty → null (reject).

   Plus the read-through: the tab's title carries an onDoubleClick → inline
   edit (the DesktopStrip pattern). */

interface TabRenameModule {
  tabRenameTarget(tab: { kind: string; sessionId?: string; terminalId?: string }): { kind: "session" | "terminal"; id: string } | null;
  cleanTabTitle(input: string): string | null;
}

async function load(): Promise<TabRenameModule | null> {
  const spec = "../src/lib/tabRename"; // variable specifier: typechecks before the module exists
  return import(spec).catch(() => null);
}

test("src/lib/tabRename.ts exists", async () => {
  const mod = await load();
  assert.ok(mod, "src/lib/tabRename.ts must export tabRenameTarget + cleanTabTitle — see issue #141");
});

test("the target matrix: chats rename sessions, shells rename terminals, the rest never", async () => {
  const mod = await load();
  assert.ok(mod, "tabRename module must exist (see module test)");

  assert.deepEqual(mod.tabRenameTarget({ kind: "chat", sessionId: "s1" }), { kind: "session", id: "s1" });
  assert.deepEqual(mod.tabRenameTarget({ kind: "terminal", terminalId: "t1" }), { kind: "terminal", id: "t1" });
  assert.equal(mod.tabRenameTarget({ kind: "feed" }), null, "feed tabs aren't renamable");
  assert.equal(mod.tabRenameTarget({ kind: "chat" }), null, "a chat tab without a session id can't rename");
  assert.equal(mod.tabRenameTarget({ kind: "terminal" }), null);
  assert.doesNotThrow(() => mod.tabRenameTarget({ kind: "mystery" }));
});

test("cleanTabTitle: trim, cap 64, empty rejected", async () => {
  const mod = await load();
  assert.ok(mod, "tabRename module must exist (see module test)");

  assert.equal(mod.cleanTabTitle("  my chat  "), "my chat");
  assert.equal(mod.cleanTabTitle("x".repeat(80))!.length, 64, "capped at the terminal rule");
  assert.equal(mod.cleanTabTitle("   "), null, "blank never applies");
  assert.equal(mod.cleanTabTitle(""), null);
});

test("read-through: the panel tab's title carries the double-click rename", () => {
  const src = readFileSync(new URL("../src/components/Workspace.tsx", import.meta.url), "utf8");
  const tabRegion = src.slice(src.indexOf("KIND_ICON"));
  assert.ok(
    /onDoubleClick/.test(tabRegion) && /rename/i.test(tabRegion),
    "the panel tab title must double-click into an inline rename (DesktopStrip's beginRename pattern) — today nothing answers a double-click",
  );
});
