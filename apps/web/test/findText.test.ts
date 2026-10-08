import { test } from "node:test";
import assert from "node:assert/strict";
import { locateOffset, joinBufferLines } from "../src/lib/findText";
import { findMatches } from "../src/lib/findInPanel";

/* Pins for the find offset math (issue #194) — the mappings both providers
   in lib/findRuntime.ts rely on after findMatches hands back flat offsets. */

test("locateOffset: fragment + offset at every boundary", () => {
  /* fragments "abc" (chars 0..2), "de" (3..4), "fgh" (5..7) — joined "abcdefgh".
     (Empty fragments are skipped upstream and never listed.) */
  const starts = [0, 3, 5];
  const lengths = [3, 2, 3];

  assert.deepEqual(locateOffset(starts, lengths, 0), { fragment: 0, offset: 0 }, "first char");
  assert.deepEqual(locateOffset(starts, lengths, 2), { fragment: 0, offset: 2 }, "last char of a fragment");
  assert.deepEqual(locateOffset(starts, lengths, 3), { fragment: 1, offset: 0 }, "a boundary index opens the NEXT fragment");
  assert.deepEqual(locateOffset(starts, lengths, 7), { fragment: 2, offset: 2 });
  assert.deepEqual(locateOffset(starts, lengths, 8), { fragment: 2, offset: 3 }, "one past the last char: a valid Range end");
  assert.equal(locateOffset(starts, lengths, 9), null, "beyond the text is out of bounds");
  assert.equal(locateOffset(starts, lengths, -1), null);
  assert.equal(locateOffset([], [], 0), null, "no fragments at all");
});

test("locateOffset: a findMatches span reads back across fragment seams", () => {
  /* fragments as a DOM walk would emit them, with matches crossing seams */
  const frags = ["the ra", "in in sp", "ain"];
  const starts = [0, 6, 14];
  const lengths = frags.map((f) => f.length);
  const text = frags.join(""); // "the rain in spain"

  const readSpan = (index: number, length: number) => {
    const a = locateOffset(starts, lengths, index)!;
    const b = locateOffset(starts, lengths, index + length)!;
    assert.ok(a && b, "every match endpoint lands inside a fragment");
    let out = frags[a.fragment].slice(a.offset, a.fragment === b.fragment ? b.offset : undefined);
    for (let f = a.fragment + 1; f < b.fragment; f++) out += frags[f];
    if (b.fragment > a.fragment) out += frags[b.fragment].slice(0, b.offset);
    return out;
  };

  const matches = findMatches(text, "in");
  assert.deepEqual(matches.map((m) => m.index), [6, 9, 15]);
  assert.deepEqual(matches.map((m) => readSpan(m.index, m.length)), ["in", "in", "in"], "every span reconstructs the query, seam-crossers included");
});

test("joinBufferLines: wraps join bare, hard breaks join with a newline", () => {
  assert.equal(
    joinBufferLines([
      { text: "git co", wrapped: false },
      { text: "mmit", wrapped: true },
      { text: "done", wrapped: false },
    ]),
    "git commit\ndone",
    "a soft-wrapped command is one logical line",
  );
  assert.equal(joinBufferLines([]), "");
  assert.equal(joinBufferLines([{ text: "only", wrapped: false }]), "only", "no trailing separator");
});

test("a single-line query matches across a wrap but never a hard break", () => {
  const joined = joinBufferLines([
    { text: "abc", wrapped: false },
    { text: "def", wrapped: true },
    { text: "ghi", wrapped: false },
  ]); // "abcdef\nghi"
  assert.equal(findMatches(joined, "cdef").length, 1, "the soft wrap is invisible to the match");
  assert.equal(findMatches(joined, "defghi").length, 0, "the hard break separates — \\n is never in a single-line query");
});
