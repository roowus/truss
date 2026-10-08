import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* SPEC-TESTS for app-native find (Cmd+F) — https://github.com/roowus/truss/issues/194
   ("The app should have its native Cmd+F"). These FAIL on purpose today:
   they pin the contract a fix must satisfy.

   Today: nothing intercepts Cmd+F — the browser's native find opens, which
   is useless in truss: dockview panels each carry their own content and
   chat renders are per-panel; the browser search can't scope to the focused
   panel and can't scroll a session's transcript meaningfully.

   The contract: src/lib/findInPanel.ts —

     findMatches(text: string, query: string): { index: number; length: number }[]
       — case-insensitive, EVERY occurrence, LITERAL (a query like "a.*b"
         is text, never a regex); empty/blank query → []; never throws;
     cycleMatch(current: number, total: number, dir: 1 | -1): number
       — Enter/Shift+Enter wrap around;
     isFindChord(e): boolean
       — Cmd/Ctrl+F; plain f / shift variants never collide with typing;

   and the read-through: the app intercepts Cmd+F (the browser's find never
   opens over a dockview surface). */

interface FindModule {
  findMatches(text: string, query: string): { index: number; length: number }[];
  cycleMatch(current: number, total: number, dir: 1 | -1): number;
  isFindChord(e: { key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }): boolean;
}

async function load(): Promise<FindModule | null> {
  const spec = "../src/lib/findInPanel"; // variable specifier: typechecks before the module exists
  return import(spec).catch(() => null);
}

test("src/lib/findInPanel.ts exists", async () => {
  const mod = await load();
  assert.ok(mod, "src/lib/findInPanel.ts must export findMatches/cycleMatch/isFindChord — see issue #194");
});

test("findMatches: literal, case-insensitive, every occurrence, positioned", async () => {
  const mod = await load();
  assert.ok(mod, "find module must exist (see module test)");

  assert.deepEqual(mod.findMatches("the cat sat. THE CAT!", "cat"), [
    { index: 4, length: 3 },
    /* the issue's copy of this pin said 16 — off by one: "CAT" starts at
       index 17 ("the cat sat. THE " is 17 chars). Corrected to ground
       truth; flagged in the PR. */
    { index: 17, length: 3 },
  ]);
  assert.deepEqual(mod.findMatches("a.*b a.*b", "a.*b"), [
    { index: 0, length: 4 },
    { index: 5, length: 4 },
  ], "LITERAL — regex metachars are text");
  assert.deepEqual(mod.findMatches("hello", ""), [], "blank query matches nothing");
  assert.deepEqual(mod.findMatches("hello", "  "), [], "whitespace-only too");
  assert.deepEqual(mod.findMatches("", "x"), []);
  assert.doesNotThrow(() => mod.findMatches("x".repeat(200_000), "x".repeat(100)), "big transcripts don't choke");
});

test("cycleMatch wraps both directions; the chord is exactly Cmd/Ctrl+F", async () => {
  const mod = await load();
  assert.ok(mod, "find module must exist (see module test)");

  assert.equal(mod.cycleMatch(0, 5, 1), 1);
  assert.equal(mod.cycleMatch(4, 5, 1), 0, "wraps forward");
  assert.equal(mod.cycleMatch(0, 5, -1), 4, "wraps backward");
  assert.equal(mod.cycleMatch(0, 0, 1), -1, "no matches → no position");

  assert.ok(mod.isFindChord({ key: "f", metaKey: true }) && mod.isFindChord({ key: "F", ctrlKey: true }));
  assert.ok(!mod.isFindChord({ key: "f" }), "plain f types");
  assert.ok(!mod.isFindChord({ key: "f", metaKey: true, shiftKey: true }), "Cmd+Shift+F is free for something else");
});

test("read-through: the app owns Cmd+F (the browser's find never opens)", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.ok(
    /isFindChord\(/.test(app),
    "App must intercept the find chord and open the in-app find bar — today the browser's native find opens and can't see a panel (issue #194)",
  );
});
