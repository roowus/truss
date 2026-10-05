import { test } from "node:test";
import assert from "node:assert/strict";
import { terminalIdsInLayout } from "../src/lib/workspaceClose";

/* Pins the non-DOM seam of desktops.remove()'s teardown (audit round 1, B2):
   closing a workspace sweeps the shells its layout still shows so orphaned
   shells stop — and only those. The DOM-coupled half (dockview's live panel
   list) mirrors the same "terminal:<id>" id convention pinned here. */

test("terminalIdsInLayout: every terminal panel id, prefix stripped", () => {
  const layout = {
    panels: {
      "terminal:abc-123": {},
      "terminal:def-456": {},
      "chat:session-1": {},
      feed: {},
      "terminal:": {}, // degenerate id still maps to its (empty) id
    },
  };
  assert.deepEqual(terminalIdsInLayout(layout).sort(), ["", "abc-123", "def-456"]);
});

test("terminalIdsInLayout: no panels, null, or undefined layout sweeps nothing", () => {
  assert.deepEqual(terminalIdsInLayout({ panels: { "chat:x": {} } }), []);
  assert.deepEqual(terminalIdsInLayout({}), []);
  assert.deepEqual(terminalIdsInLayout(null), []);
  assert.deepEqual(terminalIdsInLayout(undefined), []);
});

test("terminalIdsInLayout: panel kinds that merely CONTAIN the prefix are untouched", () => {
  const layout = { panels: { "xterminal:trap": {}, "terminal:real": {}, "chat:terminal:y": {} } };
  assert.deepEqual(terminalIdsInLayout(layout), ["real"]);
});
