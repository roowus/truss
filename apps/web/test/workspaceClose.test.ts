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
     into an Alt chord):
       isNewWorkspaceChord  — Alt+Shift+N: new workspace (Chrome's Ctrl+N);
       isAddTabChord        — Alt+Shift+T: add tab (Chrome's Ctrl+T);
       isCloseTabChord      — Alt+W: close the active tab (Chrome's Ctrl+W;
                              Shift scales it to the workspace, Chrome-style);
       isCloseWindowChord   — Alt+Shift+W: close the active workspace; the
                              browser-reserved Cmd/Ctrl+Shift+W stays a
                              window-level legacy alias (fires mid-typing);
       isReopenClosedChord  — Alt+Shift+Z: reopen what closed last (Chrome's
                              Ctrl+Shift+T is browser-reserved);
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

test("the chords: Alt+Shift+W closes, Cmd/Ctrl+Shift+Z reopens — and only those", async () => {
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
     e.key („ on US layouts), so the chord also matches the physical e.code;
     that same OR covers AZERTY, where the physical W cap is labeled Z */
  assert.ok(mod.isCloseWindowChord({ key: "„", code: "KeyW", altKey: true, shiftKey: true }), "mac-composed glyph still fires via e.code (audit B1)");
  assert.ok(!mod.isCloseWindowChord({ key: "„", code: "KeyW", altKey: true, shiftKey: true }, true), "the mac chord yields while typing too");
  assert.ok(mod.isCloseWindowChord({ key: "z", code: "KeyW", altKey: true, shiftKey: true }), "AZERTY: the physical W cap is labeled Z");
  assert.ok(!mod.isCloseWindowChord({ key: "x", code: "KeyX", altKey: true, shiftKey: true }), "neither letter nor code, no fire");
  assert.ok(!mod.isCloseWindowChord({ key: "w", altKey: true, shiftKey: true }, true), "Alt+Shift+W yields while typing, like Alt+Shift+T");
  assert.ok(mod.isCloseWindowChord({ key: "w", metaKey: true, shiftKey: true }), "legacy mac chord");
  assert.ok(mod.isCloseWindowChord({ key: "W", ctrlKey: true, shiftKey: true }), "legacy win/linux chord, caps-tolerant");
  assert.ok(mod.isCloseWindowChord({ key: "w", metaKey: true, shiftKey: true }, true), "the legacy alias stays window-level where delivered (Chrome-style)");
  assert.ok(!mod.isCloseWindowChord({ key: "w", metaKey: true }), "plain Cmd+W is the TAB close — untouched");
  assert.ok(!mod.isCloseWindowChord({ key: "w", altKey: true }), "Alt without Shift never fires");
  assert.ok(!mod.isCloseWindowChord({ key: "w", shiftKey: true }), "no modifier, no fire");

  /* browsers reserve Cmd/Ctrl+Shift+T (the keydown never reaches a plain
     tab), so reopen lives on the undo mnemonic: Alt+Shift+Z is advertised
     with the rest of the Alt family, Cmd/Ctrl+Shift+Z keeps working as an
     alias, and Shift+T stays a legacy alias wherever a setup delivers it */
  assert.ok(mod.isReopenClosedChord({ key: "z", altKey: true, shiftKey: true }), "the advertised reopen chord (Alt family)");
  assert.ok(!mod.isReopenClosedChord({ key: "z", altKey: true, shiftKey: true }, true), "Alt+Shift+Z yields while typing like its siblings");
  assert.ok(mod.isReopenClosedChord({ key: "z", metaKey: true, shiftKey: true }), "the Shift+Z alias keeps working");
  assert.ok(mod.isReopenClosedChord({ key: "Z", ctrlKey: true, shiftKey: true }), "caps-tolerant");
  assert.ok(mod.isReopenClosedChord({ key: "t", metaKey: true, shiftKey: true }), "legacy Chrome-parity alias");
  assert.ok(!mod.isReopenClosedChord({ key: "z", metaKey: true, shiftKey: true }, true), "while typing, Shift+Z stays text redo");
  assert.ok(mod.isReopenClosedChord({ key: "t", metaKey: true, shiftKey: true }, true), "the legacy alias fires even mid-typing when delivered");
  assert.ok(!mod.isReopenClosedChord({ key: "z", metaKey: true }), "plain Cmd+Z stays undo");
  assert.ok(!mod.isReopenClosedChord({ key: "t", metaKey: true }), "plain Cmd+T stays a new tab");

  /* the chords never collide */
  assert.ok(!(mod.isCloseWindowChord({ key: "z", metaKey: true, shiftKey: true })));
  assert.ok(!(mod.isCloseWindowChord({ key: "t", metaKey: true, shiftKey: true })));
  assert.ok(!(mod.isCloseWindowChord({ key: "t", altKey: true, shiftKey: true })), "Alt+Shift+T stays add-tab");
  assert.ok(!(mod.isReopenClosedChord({ key: "w", metaKey: true, shiftKey: true })));
  assert.ok(!(mod.isReopenClosedChord({ key: "w", altKey: true, shiftKey: true })));
});

test("the Alt family: Chrome's N/T/W commands on modifiers browsers deliver (PR #184 review)", async () => {
  const mod = await load();
  assert.ok(mod, "workspaceClose module must exist (see module test)");

  /* new workspace — Chrome's Ctrl+N (browser-reserved) */
  assert.ok(mod.isNewWorkspaceChord({ key: "n", altKey: true, shiftKey: true }), "Alt+Shift+N");
  assert.ok(mod.isNewWorkspaceChord({ key: "N", altKey: true, shiftKey: true }), "caps-tolerant");
  assert.ok(!mod.isNewWorkspaceChord({ key: "n", altKey: true, shiftKey: true }, true), "yields while typing");
  assert.ok(mod.isNewWorkspaceChord({ key: "˜", code: "KeyN", altKey: true, shiftKey: true }), "mac-composed glyph fires via e.code");
  assert.ok(!mod.isNewWorkspaceChord({ key: "n", altKey: true }), "Alt+N alone never fires");
  assert.ok(!mod.isNewWorkspaceChord({ key: "n", metaKey: true }), "plain Cmd+N stays the browser's own new window");

  /* add tab — Chrome's Ctrl+T, the strip's original Alt chord */
  assert.ok(mod.isAddTabChord({ key: "t", altKey: true, shiftKey: true }), "Alt+Shift+T");
  assert.ok(!mod.isAddTabChord({ key: "t", altKey: true, shiftKey: true }, true), "yields while typing");
  assert.ok(mod.isAddTabChord({ key: "†", code: "KeyT", altKey: true, shiftKey: true }), "mac-composed glyph fires via e.code");
  assert.ok(!mod.isAddTabChord({ key: "t", altKey: true }), "Alt+T alone never fires");

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
  assert.ok(!mod.isNewWorkspaceChord({ key: "t", altKey: true, shiftKey: true }));
  assert.ok(!mod.isAddTabChord({ key: "n", altKey: true, shiftKey: true }));
  assert.ok(!mod.isReopenClosedChord({ key: "n", altKey: true, shiftKey: true }));
  assert.ok(!mod.isCloseTabChord({ key: "z", altKey: true, shiftKey: true }), "Alt+Shift+Z is reopen, not close-tab");
  assert.ok(!mod.isCloseTabChord({ key: "n", altKey: true }));
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
