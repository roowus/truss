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
     isCloseWindowChord(e) / isReopenClosedChord(e)
       — Cmd/Ctrl+Shift+W and Cmd/Ctrl+Shift+T, case-insensitive, unshifted
         chords never fire;
     pushClosed(stack, snapshot) / popClosed(stack)
       — the undo stack for "reopen what I closed" (capped; LIFO; the
         snapshot carries name + layout so the workspace returns as it was). */

interface Space {
  id: string;
  name?: string;
  layout?: unknown;
}
interface WorkspaceCloseModule {
  canClose(spaces: Space[], id: string): boolean;
  nextActiveAfterClose(spaces: Space[], closedId: string, activeId: string): string;
  isCloseWindowChord(e: { key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }): boolean;
  isReopenClosedChord(e: { key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }, typing?: boolean): boolean;
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

test("the chords: Cmd/Ctrl+Shift+W closes, Cmd/Ctrl+Shift+Z reopens — and only those", async () => {
  const mod = await load();
  assert.ok(mod, "workspaceClose module must exist (see module test)");

  assert.ok(mod.isCloseWindowChord({ key: "w", metaKey: true, shiftKey: true }), "mac chord");
  assert.ok(mod.isCloseWindowChord({ key: "W", ctrlKey: true, shiftKey: true }), "win/linux chord, caps-tolerant");
  assert.ok(!mod.isCloseWindowChord({ key: "w", metaKey: true }), "plain Cmd+W is the TAB close — untouched");
  assert.ok(!mod.isCloseWindowChord({ key: "w", shiftKey: true }), "no modifier, no fire");

  /* browsers reserve Cmd/Ctrl+Shift+T (the keydown never reaches a plain
     tab), so the reachable reopen chord is Shift+Z; Shift+T stays as a
     legacy alias wherever a setup does pass it through */
  assert.ok(mod.isReopenClosedChord({ key: "z", metaKey: true, shiftKey: true }), "the advertised reopen chord");
  assert.ok(mod.isReopenClosedChord({ key: "Z", ctrlKey: true, shiftKey: true }), "caps-tolerant");
  assert.ok(mod.isReopenClosedChord({ key: "t", metaKey: true, shiftKey: true }), "legacy Chrome-parity alias");
  assert.ok(!mod.isReopenClosedChord({ key: "z", metaKey: true, shiftKey: true }, true), "while typing, Shift+Z stays text redo");
  assert.ok(mod.isReopenClosedChord({ key: "t", metaKey: true, shiftKey: true }, true), "the legacy alias fires even mid-typing when delivered");
  assert.ok(!mod.isReopenClosedChord({ key: "z", metaKey: true }), "plain Cmd+Z stays undo");
  assert.ok(!mod.isReopenClosedChord({ key: "t", metaKey: true }), "plain Cmd+T stays a new tab");

  /* the chords never collide */
  assert.ok(!(mod.isCloseWindowChord({ key: "z", metaKey: true, shiftKey: true })));
  assert.ok(!(mod.isCloseWindowChord({ key: "t", metaKey: true, shiftKey: true })));
  assert.ok(!(mod.isReopenClosedChord({ key: "w", metaKey: true, shiftKey: true })));
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
