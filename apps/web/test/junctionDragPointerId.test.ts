import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* Pins the pointerId guard on junction drags — audit follow-up on issue
   #192's fix (finding B2). The drag's move/up listeners live on WINDOW (so
   handle churn can't orphan the gesture), which means they see EVERY
   pointer: without a filter, a second finger or pen mid-drag would feed
   foreign deltas (the junction jumps) and its pointerup would settle
   someone else's gesture. Pointer capture used to filter implicitly; the
   window listeners must do it explicitly. */

const SRC = () => readFileSync(new URL("../src/components/SplitJunctions.tsx", import.meta.url), "utf8");

test("pointerdown records which pointer owns the gesture", () => {
  assert.match(SRC(), /pointerId\s*=\s*e\.pointerId/, "the grabbing pointer's id is captured at drag start");
});

test("window move and up/cancel both ignore foreign pointers", () => {
  const guards = SRC().match(/ev\.pointerId !== pointerId/g) ?? [];
  assert.ok(guards.length >= 2, "the move path AND the release path filter by the grabbing pointerId (audit B2)");
});
