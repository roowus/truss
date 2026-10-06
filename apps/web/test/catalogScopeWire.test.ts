import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* Wiring tests for catalog scope notes — https://github.com/roowus/truss/issues/170.
   catalogScope.test.ts pins the helper's contract; this file pins that the
   note actually reaches the picker's open list:

   1. ChatPanel derives the note from the same harness-scoped catalog the
      options come from, and hands it to the Select as `note`;
   2. Select renders that note under the option list, pinned to the
      popover's bottom edge so a long list can't scroll it out of view. */

const PANEL = readFileSync(new URL("../src/panels/ChatPanel.tsx", import.meta.url), "utf8");
const SELECT = readFileSync(new URL("../src/components/ui.tsx", import.meta.url), "utf8");

test("ChatPanel feeds catalogScopeNote the harness-scoped catalog", () => {
  assert.ok(
    /catalogScopeNote\(\s*models\.filter\(\(m\)\s*=>\s*m\.harness === baseHarness\(meta\.harness\)\)\s*\)/.test(PANEL),
    "the note describes the list the picker shows — the base harness's catalog rows, not the whole catalog",
  );
  assert.ok(/<Select[\s\S]*?note=\{scopeNote\}/.test(PANEL), "the model picker receives the scope note");
});

test("Select renders the note under the list, pinned to the popover bottom", () => {
  assert.ok(/note\?: string \| null/.test(SELECT), "Select accepts an optional note");
  const noteBlock = SELECT.match(/\{note && \([\s\S]*?\)\}/);
  assert.ok(noteBlock, "the note renders only when present");
  assert.ok(/sticky bottom-0/.test(noteBlock![0]), "the note sticks to the list's bottom edge like the filter sticks to its top");
  assert.ok(/border-t/.test(noteBlock![0]), "visually separated from the options above");
});
