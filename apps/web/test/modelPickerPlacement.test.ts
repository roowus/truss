import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* SPEC-TESTS for the model picker's home — https://github.com/roowus/truss/issues/143
   ("Move the model selector from the top to the bottom chat bar"). These
   FAIL on purpose today: they pin the contract a fix must satisfy.

   Today the model Select lives in the chat HEADER (ChatPanel.tsx — inside
   the h-10 header row, with a collapse path into the ⋯ overflow via the
   headerFit planner's "select" item, headerFit.ts:64-69). The ask: it
   belongs with the composer (the bottom bar with clip/mic/send), like every
   modern chat app — the control you touch while writing a message.

   The contract:
   1. HEADER_CLUSTER no longer carries "select" — the header never plans
      for it (not even as overflow);
   2. read-through on ChatPanel.tsx: the "Switch model" Select renders
      inside the composer container, and NOT in the header row;
   3. it must stay usable while a draft is mid-run-blocked (the composer's
      input lock is about TEXT, not the model). */

const PANEL = readFileSync(new URL("../src/panels/ChatPanel.tsx", import.meta.url), "utf8");

test("headerFit's HEADER_CLUSTER drops the model select", async () => {
  const mod: any = await import("../src/lib/headerFit.js");
  assert.ok(mod.HEADER_CLUSTER, "headerFit module loads");
  assert.ok(
    !mod.HEADER_CLUSTER.some((it: { id: string }) => it.id === "select"),
    "the model picker leaves the header cluster entirely — it lives in the composer now (issue #143)",
  );
});

test("read-through: the Select renders in the composer, never the header", () => {
  /* the header row: the h-10 bordered strip; the composer: the rounded-xl
     border container with the textarea */
  const headerStart = PANEL.indexOf('className="relative shrink-0 flex items-center gap-2 px-3 h-10 border-b');
  const composerStart = PANEL.indexOf("flex items-end gap-1.5 rounded-xl border");
  assert.ok(headerStart > 0 && composerStart > headerStart, "both regions found");

  const headerRegion = PANEL.slice(headerStart, composerStart);
  const composerRegion = PANEL.slice(composerStart);

  assert.ok(!headerRegion.includes('ariaLabel="Switch model"'), "the header carries no model Select");
  assert.ok(composerRegion.includes('ariaLabel="Switch model"'), "the composer carries the model Select");
});

test("the composer select isn't chained to the input lock", () => {
  const composerStart = PANEL.indexOf("flex items-end gap-1.5 rounded-xl border");
  const composerRegion = PANEL.slice(composerStart);
  const sel = composerRegion.indexOf('ariaLabel="Switch model"');
  assert.ok(sel > 0, "the select is there (see the placement test)");
  const around = composerRegion.slice(Math.max(0, sel - 600), sel);
  assert.ok(
    !/disabled=\{blocked\}/.test(around),
    "the model select must stay usable while the draft is locked mid-run — model switching is not text input",
  );
});
