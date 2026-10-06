import { test } from "node:test";
import assert from "node:assert/strict";

/* SPEC-TESTS for closing whole workspaces — https://github.com/roowus/truss/issues/115
   ("Allow me to close entire windows all together like Chrome can"). These
   FAIL on purpose today: they pin the contract a fix must satisfy.

   Today: workspace close exists but is buried — right-click the workspace
   tab → "Delete workspace" → "Confirm delete" (DesktopStrip.tsx), a
   two-step menu. Chrome's model: a window's X closes everything in ONE
   gesture, Cmd+Shift+W closes the window, Cmd+Shift+T reopens what you
   just closed.

   The contract: a pure src/lib/workspaceClose.ts —

     canClose(spaces, id): boolean
       — never the last workspace standing (Chrome quits; truss keeps ≥1);
     nextActiveAfterClose(spaces, closedId, activeId): string
       — closing the ACTIVE workspace activates the neighbor to its LEFT
         (Chrome's rule), falling back right; closing a background workspace
         keeps the active one;
     the chord family (predicates take (e, typing?); every Alt chord yields
     while typing; mac-composed glyphs match via e.code; Cmd/Ctrl never mix
     into an Alt chord). Chrome's own chords one for one, Alt for Ctrl/Cmd:
       isNewWorkspaceChord  — Alt+N: new workspace (Ctrl+N);
       isAddTabChord        — Alt+T: add tab (Ctrl+T);
       isCloseTabChord      — Alt+W: close the active tab (Ctrl+W);
       isCloseWindowChord   — Alt+Shift+W: close the active workspace
                              (Ctrl+Shift+W); the browser-reserved
                              Cmd/Ctrl+Shift+W stays a window-level legacy
                              alias (fires mid-typing);
       isReopenClosedChord  — Alt+Shift+T: reopen what closed last (Chrome's
                              Ctrl+Shift+T, browser-reserved, finally
                              reachable in its Shift+T shape);
                              Cmd/Ctrl+Shift+Z and Shift+T keep working as
                              aliases (Shift+T window-level, Shift+Z yields
                              while typing — it is text redo);
       case-insensitive; unshifted/unmodified chords never fire;
     pushClosed(stack, snapshot) / popClosed(stack)
       — the undo stack for "reopen what I closed" (capped; LIFO; the
         snapshot carries name + layout so the workspace returns as it was). */

interface Space {
  id: string;
  name?: string;
  layout?: unknown;
}
interface ChordEv {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}
interface WorkspaceCloseModule {
  canClose(spaces: Space[], id: string): boolean;
  nextActiveAfterClose(spaces: Space[], closedId: string, activeId: string): string;
  isNewWorkspaceChord(e: ChordEv, typing?: boolean): boolean;
  isAddTabChord(e: ChordEv, typing?: boolean): boolean;
  isCloseTabChord(e: ChordEv, typing?: boolean): boolean;
  isCloseWindowChord(e: ChordEv, typing?: boolean): boolean;
  isReopenClosedChord(e: ChordEv, typing?: boolean): boolean;
  activePanelToClose(get: (spaceId: string) => { activePanel?: { id: string } | null } | undefined, activeId: string): { id: string } | null;
  pushClosed(stack: unknown[], snapshot: unknown, cap?: number): unknown[];
  popClosed(stack: unknown[]): { snapshot: unknown; rest: unknown[] } | null;
}

async function load(): Promise<WorkspaceCloseModule | null> {
  const spec = "../src/lib/workspaceClose"; // variable specifier: typechecks before the module exists
  return import(spec).catch(() => null);
}

const SPACES = [{ id: "a" }, { id: "b" }, { id: "c" }];

test("src/lib/workspaceClose.ts exists", async () => {
  const mod = await load();
  assert.ok(mod, "src/lib/workspaceClose.ts must exist — see issue #115");
});

test("close guards: the last workspace never dies; the active neighbor follows Chrome's leftward rule", async () => {
  const mod = await load();
  assert.ok(mod, "workspaceClose module must exist (see module test)");

  assert.equal(mod.canClose(SPACES, "b"), true);
  assert.equal(mod.canClose([{ id: "solo" }], "solo"), false, "the last window stands (truss ≠ quit)");
  assert.equal(mod.canClose(SPACES, "ghost"), false, "ghosts can't close");

  assert.equal(mod.nextActiveAfterClose(SPACES, "b", "b"), "a", "closing the active one: the LEFT neighbor wakes (Chrome's rule)");
  assert.equal(mod.nextActiveAfterClose(SPACES, "a", "a"), "b", "leftmost closed → fall back right");
  assert.equal(mod.nextActiveAfterClose(SPACES, "c", "c"), "b");
  assert.equal(mod.nextActiveAfterClose(SPACES, "c", "a"), "a", "closing a background workspace never yanks focus");
});

test("the chords: Alt+Shift+W closes, Alt+Shift+T reopens — and only those", async () => {
  const mod = await load();
  assert.ok(mod, "workspaceClose module must exist (see module test)");

  /* browsers reserve Cmd/Ctrl+Shift+W for their own window close (the keydown
     never reaches a plain tab — verified in #122), so the advertised close
     chord is Alt+Shift+W: the strip's Alt+Shift+<letter> pattern (Alt+Shift+T
     adds a tab), unreserved in Chrome/Firefox/Safari. Shift+W stays as a
     legacy alias for keyboard-lock/embedded setups that pass it through. */
  assert.ok(mod.isCloseWindowChord({ key: "w", altKey: true, shiftKey: true }), "the advertised close chord (issue #181)");
  assert.ok(mod.isCloseWindowChord({ key: "W", altKey: true, shiftKey: true }), "caps-tolerant");
  /* macOS: Option is a composer — Option+Shift+W reports a composed glyph as
     e.key („ on US layouts), so a glyph falls back to the physical e.code;
     that same fallback covers a dead-key shape */
  assert.ok(mod.isCloseWindowChord({ key: "„", code: "KeyW", altKey: true, shiftKey: true }), "mac-composed glyph still fires via e.code (audit B1)");
  assert.ok(!mod.isCloseWindowChord({ key: "„", code: "KeyW", altKey: true, shiftKey: true }, true), "the mac chord yields while typing too");
  /* AZERTY swaps Z/W vs QWERTY: the printed letter rules — the W-labeled key
     (physical code KeyZ) CLOSES; the Z-labeled key (code KeyW) closes nothing
     and reopens nothing (the Alt family has no Z). A plain key|code OR would
     double-fire these shapes (round-3 audit, B1) — pin both against BOTH
     predicates */
  assert.ok(!mod.isCloseWindowChord({ key: "z", code: "KeyW", altKey: true, shiftKey: true }), "AZERTY: the Z-labeled key is NOT close");
  assert.ok(!mod.isReopenClosedChord({ key: "z", code: "KeyW", altKey: true, shiftKey: true }), "AZERTY: the Z-labeled key is not reopen either — the family has no Z");
  assert.ok(mod.isCloseWindowChord({ key: "w", code: "KeyZ", altKey: true, shiftKey: true }), "AZERTY: the W-labeled key closes");
  assert.ok(!mod.isReopenClosedChord({ key: "w", code: "KeyZ", altKey: true, shiftKey: true }), "AZERTY: the W-labeled key is NOT reopen");
  assert.ok(!mod.isCloseWindowChord({ key: "x", code: "KeyX", altKey: true, shiftKey: true }), "neither letter nor code, no fire");
  assert.ok(!mod.isCloseWindowChord({ key: "w", altKey: true, shiftKey: true }, true), "Alt+Shift+W yields while typing, like Alt+Shift+T");
  assert.ok(mod.isCloseWindowChord({ key: "w", metaKey: true, shiftKey: true }), "legacy mac chord");
  assert.ok(mod.isCloseWindowChord({ key: "W", ctrlKey: true, shiftKey: true }), "legacy win/linux chord, caps-tolerant");
  assert.ok(mod.isCloseWindowChord({ key: "w", metaKey: true, shiftKey: true }, true), "the legacy alias stays window-level where delivered (Chrome-style)");
  assert.ok(!mod.isCloseWindowChord({ key: "w", metaKey: true }), "plain Cmd+W is the TAB close — untouched");
  assert.ok(!mod.isCloseWindowChord({ key: "w", altKey: true }), "Alt without Shift never fires");
  assert.ok(!mod.isCloseWindowChord({ key: "w", shiftKey: true }), "no modifier, no fire");

  /* browsers reserve Cmd/Ctrl+Shift+T (the keydown never reaches a plain
     tab), so reopen takes Chrome's own Shift+T shape on the deliverable
     modifier: Alt+Shift+T. Cmd/Ctrl+Shift+Z ("undo the close") and the
     reserved Cmd/Ctrl+Shift+T keep working as aliases */
  assert.ok(mod.isReopenClosedChord({ key: "t", altKey: true, shiftKey: true }), "the advertised reopen chord — Chrome's Ctrl+Shift+T on Alt");
  assert.ok(!mod.isReopenClosedChord({ key: "t", altKey: true, shiftKey: true }, true), "Alt+Shift+T yields while typing like its siblings");
  assert.ok(mod.isReopenClosedChord({ key: "†", code: "KeyT", altKey: true, shiftKey: true }), "mac-composed glyph fires via e.code");
  assert.ok(mod.isReopenClosedChord({ key: "z", metaKey: true, shiftKey: true }), "the Shift+Z alias keeps working");
  assert.ok(mod.isReopenClosedChord({ key: "Z", ctrlKey: true, shiftKey: true }), "caps-tolerant");
  assert.ok(mod.isReopenClosedChord({ key: "t", metaKey: true, shiftKey: true }), "legacy Chrome-parity alias");
  assert.ok(!mod.isReopenClosedChord({ key: "z", metaKey: true, shiftKey: true }, true), "while typing, Shift+Z stays text redo");
  assert.ok(mod.isReopenClosedChord({ key: "t", metaKey: true, shiftKey: true }, true), "the legacy alias fires even mid-typing when delivered");
  assert.ok(!mod.isReopenClosedChord({ key: "z", metaKey: true }), "plain Cmd+Z stays undo");
  assert.ok(!mod.isReopenClosedChord({ key: "t", metaKey: true }), "plain Cmd+T stays a new tab");
  assert.ok(!mod.isReopenClosedChord({ key: "t", altKey: true }), "Alt+T alone is ADD TAB — not reopen");

  /* the chords never collide */
  assert.ok(!(mod.isCloseWindowChord({ key: "z", metaKey: true, shiftKey: true })));
  assert.ok(!(mod.isCloseWindowChord({ key: "t", metaKey: true, shiftKey: true })));
  assert.ok(!(mod.isCloseWindowChord({ key: "t", altKey: true, shiftKey: true })), "Alt+Shift+T is reopen — not close");
  assert.ok(!(mod.isReopenClosedChord({ key: "w", metaKey: true, shiftKey: true })));
  assert.ok(!(mod.isReopenClosedChord({ key: "w", altKey: true, shiftKey: true })));
});

test("the Alt family: Chrome's N/T/W commands on modifiers browsers deliver (PR #184 review)", async () => {
  const mod = await load();
  assert.ok(mod, "workspaceClose module must exist (see module test)");

  /* new workspace — Chrome's Ctrl+N (browser-reserved) */
  assert.ok(mod.isNewWorkspaceChord({ key: "n", altKey: true }), "Alt+N");
  assert.ok(mod.isNewWorkspaceChord({ key: "N", altKey: true }), "caps-tolerant");
  assert.ok(!mod.isNewWorkspaceChord({ key: "n", altKey: true }, true), "yields while typing");
  assert.ok(mod.isNewWorkspaceChord({ key: "Dead", code: "KeyN", altKey: true }), "mac Option+N is a dead key — e.code catches it");
  assert.ok(!mod.isNewWorkspaceChord({ key: "n", altKey: true, shiftKey: true }), "Alt+Shift+N never fires (Chrome has no Shift+N in the family)");
  assert.ok(!mod.isNewWorkspaceChord({ key: "n" }), "plain N stays new session");
  assert.ok(!mod.isNewWorkspaceChord({ key: "n", metaKey: true }), "plain Cmd+N stays the browser's own new window");

  /* add tab — Chrome's Ctrl+T; the Shift form is Chrome's reopen */
  assert.ok(mod.isAddTabChord({ key: "t", altKey: true }), "Alt+T");
  assert.ok(!mod.isAddTabChord({ key: "t", altKey: true }, true), "yields while typing");
  assert.ok(mod.isAddTabChord({ key: "†", code: "KeyT", altKey: true }), "mac-composed glyph fires via e.code");
  assert.ok(!mod.isAddTabChord({ key: "t", altKey: true, shiftKey: true }), "Alt+Shift+T is REOPEN — Chrome's Ctrl+Shift+T");

  /* close the active tab — Chrome's Ctrl+W; Shift scales it to the workspace, Chrome-style */
  assert.ok(mod.isCloseTabChord({ key: "w", altKey: true }), "Alt+W");
  assert.ok(mod.isCloseTabChord({ key: "W", altKey: true }), "caps-tolerant");
  assert.ok(!mod.isCloseTabChord({ key: "w", altKey: true }, true), "yields while typing");
  assert.ok(mod.isCloseTabChord({ key: "∑", code: "KeyW", altKey: true }), "mac-composed glyph fires via e.code");
  assert.ok(!mod.isCloseTabChord({ key: "w", altKey: true, shiftKey: true }), "Alt+Shift+W is the WORKSPACE close — not the tab one");
  assert.ok(!mod.isCloseTabChord({ key: "w", metaKey: true }), "plain Cmd+W stays the browser's tab close");
  assert.ok(!mod.isCloseTabChord({ key: "w", altKey: true, ctrlKey: true }), "AltGr (Ctrl+Alt) is typing, not a chord");

  /* the family never collides, in either direction */
  assert.ok(!mod.isCloseWindowChord({ key: "w", altKey: true }), "Alt+W is the TAB close — the workspace keeps its Shift");
  assert.ok(!mod.isNewWorkspaceChord({ key: "t", altKey: true }));
  assert.ok(!mod.isAddTabChord({ key: "n", altKey: true }));
  assert.ok(!mod.isReopenClosedChord({ key: "n", altKey: true }));
  assert.ok(!mod.isReopenClosedChord({ key: "t", altKey: true }), "Alt+T alone is add-tab, not reopen");
  assert.ok(!mod.isAddTabChord({ key: "t", altKey: true, shiftKey: true }), "Alt+Shift+T is reopen, not add-tab");
  assert.ok(!mod.isCloseTabChord({ key: "t", altKey: true }));
  assert.ok(!mod.isCloseTabChord({ key: "n", altKey: true }));
});

test("activePanelToClose: the ACTIVE workspace's active tab, or a no-op (round-3 audit, B3)", async () => {
  const mod = await load();
  assert.ok(mod, "workspaceClose module must exist (see module test)");

  const apis = new Map<string, { activePanel?: { id: string } | null }>([
    ["a", { activePanel: { id: "chat:1" } }],
    ["b", { activePanel: { id: "chat:2" } }],
    ["empty", { activePanel: null }],
  ]);
  const get = (id: string) => apis.get(id);

  assert.equal(mod.activePanelToClose(get, "b")?.id, "chat:2", "the active workspace's active tab — not another workspace's");
  assert.equal(mod.activePanelToClose(get, "a")?.id, "chat:1");
  assert.equal(mod.activePanelToClose(get, "empty"), null, "no active panel → the chord does nothing");
  assert.equal(mod.activePanelToClose(get, "ghost"), null, "no live dockview api → the chord does nothing");
});

test("the undo stack: LIFO, capped, snapshots carry name + layout", async () => {
  const mod = await load();
  assert.ok(mod, "workspaceClose module must exist (see module test)");

  let stack: unknown[] = [];
  stack = mod.pushClosed(stack, { name: "research", layout: { panels: ["chat:1"] }, at: 1 });
  stack = mod.pushClosed(stack, { name: "ops", layout: { panels: ["feed:1"] }, at: 2 });
  assert.equal(stack.length, 2);

  const popped = mod.popClosed(stack);
  assert.equal((popped?.snapshot as { name: string }).name, "ops", "most recent reopens first (LIFO)");
  assert.equal((popped?.snapshot as { layout: { panels: string[] } }).layout.panels[0], "feed:1", "the layout comes back whole");
  assert.equal(popped?.rest.length, 1);

  /* the cap: old entries drop off, never unbounded (25 since #124 put hungry
     tab closes on the same stack; Chrome keeps ~25) */
  let big: unknown[] = [];
  for (let i = 0; i < 30; i++) big = mod.pushClosed(big, { name: `w${i}` });
  assert.ok(big.length <= 25, `bounded (got ${big.length})`);
  assert.equal((mod.popClosed(big)?.snapshot as { name: string }).name, "w29", "still LIFO at the cap");

  assert.equal(mod.popClosed([]), null, "empty stack → nothing to reopen");
});
