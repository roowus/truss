import { test } from "node:test";
import assert from "node:assert/strict";
import { workspaceIndexFromChord } from "../src/lib/workspaceClose";

/* SPEC-TESTS for the Alt+1-9 workspace switch — https://github.com/roowus/truss/issues/186
   (finding B1 of the PR #184 audit). The App.tsx handler matched e.key only:

     e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)

   which is dead on macOS: Option is a composer, so Option+1 reports "¡" as
   e.key on a US layout (Option+2 "™", Option+3 "£", …) and the regex never
   matches. The chord silently did nothing on the exact platform the letter
   chords (Alt+N/T/W) were already fixed for in #181 — those route through
   altChord/letterOf in src/lib/workspaceClose.ts, which falls back to e.code
   when Option composition replaced the printed character with a glyph.

   The same discipline, for digits: the plain e.key OR e.code match that the
   letters use would DOUBLE-FIRE on non-QWERTY layouts (the lesson from the
   round-3 audit on the letter chords): on AZERTY the digit row is SHIFTED —
   the 1-labeled key reports key "&" with code "Digit1", so a "&" typed with
   Alt held would fire the switch through e.code, and the physical-Digit1
   gesture would fire it twice. So: plain-digit e.key first (the printed
   digit is what the chord means, and the tooltips advertise Alt+<N>), and
   e.code only when e.key carried no digit at all (the macOS Option glyph).

   The contract:
     workspaceIndexFromChord(e): number | null
       — 0-based index of the workspace the chord selects, or null;
       — Alt, no Shift/Ctrl/Cmd (AltGr is typing, not a chord);
       — plain digit e.key ("1".."9", i.e. no Shift) → that digit, whatever
         e.code says (a layout's printed digit is the meaning);
       — e.key not a plain digit → fall back to e.code Digit1..Digit9, which
         is the macOS Option-glyph path (Option+1 → key "¡", code "Digit1");
       — a glyph whose e.code is not a digit never fires (no stray matches);
       — never both at once: one event yields one index, never two. */

test("Alt+<digit> selects a workspace — and the macOS Option glyph fires via e.code", () => {
  /* the macOS bug this issue is about: Option+1 on a US layout composes "¡",
     so a key-only regex is dead; the physical code carries the digit */
  assert.equal(workspaceIndexFromChord({ key: "¡", code: "Digit1", altKey: true }), 0, "Option+1 (key ¡) still switches to workspace 1");
  assert.equal(workspaceIndexFromChord({ key: "™", code: "Digit2", altKey: true }), 1, "Option+2 (key ™) still switches to workspace 2");
  assert.equal(workspaceIndexFromChord({ key: "£", code: "Digit3", altKey: true }), 2, "Option+3 (key £) still switches to workspace 3");
  assert.equal(workspaceIndexFromChord({ key: "•", code: "Digit8", altKey: true }), 7, "Option+8 (key •) still switches to workspace 8");
  assert.equal(workspaceIndexFromChord({ key: "ª", code: "Digit9", altKey: true }), 8, "Option+9 (key ª) still switches to workspace 9");

  /* the plain path a layout that delivers a digit already took */
  assert.equal(workspaceIndexFromChord({ key: "1", code: "Digit1", altKey: true }), 0, "Alt+1");
  assert.equal(workspaceIndexFromChord({ key: "5", code: "Digit5", altKey: true }), 4, "Alt+5");
  assert.equal(workspaceIndexFromChord({ key: "9", code: "Digit9", altKey: true }), 8, "Alt+9");

  /* no Shift: the tooltips and the palette advertise Alt+<N>, and the chord
     is the workspace switch — Alt+Shift+<digit> is some other gesture (a real
     Shift+1 sets shiftKey AND reports "!", so the shiftKey guard rejects it
     before the code fallback can see Digit1) */
  assert.equal(workspaceIndexFromChord({ key: "1", code: "Digit1", altKey: true, shiftKey: true }), null, "Alt+Shift+1 is not the switch");
  assert.equal(workspaceIndexFromChord({ key: "!", code: "Digit1", altKey: true, shiftKey: true }), null, "the real Shift+1 event is not the switch");
  /* the digit row beyond 9 is not a workspace */
  assert.equal(workspaceIndexFromChord({ key: "0", code: "Digit0", altKey: true }), null, "Alt+0 selects nothing");

  /* the modifier frame: Alt alone, and AltGr (Ctrl+Alt) is typing */
  assert.equal(workspaceIndexFromChord({ key: "1", code: "Digit1" }), null, "no modifier, no fire");
  assert.equal(workspaceIndexFromChord({ key: "1", code: "Digit1", metaKey: true, altKey: true }), null, "Cmd+Alt is not the chord");
  assert.equal(workspaceIndexFromChord({ key: "1", code: "Digit1", ctrlKey: true, altKey: true }), null, "AltGr (Ctrl+Alt) is typing, not a chord");

  /* non-matching keys never fire */
  assert.equal(workspaceIndexFromChord({ key: "a", code: "KeyA", altKey: true }), null, "a letter is not a workspace digit");
  assert.equal(workspaceIndexFromChord({ key: "¡", code: "KeyA", altKey: true }), null, "glyph with a non-digit code never fires");
  assert.equal(workspaceIndexFromChord({ key: "Dead", altKey: true }), null, "a dead key with no code never fires");
  assert.equal(workspaceIndexFromChord({ key: "¡", altKey: true }), null, "a glyph with no code never fires");
});

test("no double-fire: one event yields one index, never two (the AZERTY trap, round-3 audit)", () => {
  /* AZERTY: the digit row is SHIFTED — the 1-labeled key reports key "&" with
     code "Digit1". The letters' plain-key-OR-code match double-fired on
     exactly this shape. The digit chord must not: when e.key is a plain digit
     it decides ALONE, and a glyph falls to e.code only when e.key carried no
     digit. One keydown → one workspace. */
  const fires = (e: Parameters<typeof workspaceIndexFromChord>[0]) => (workspaceIndexFromChord(e) === null ? 0 : 1);

  assert.equal(fires({ key: "1", code: "Digit1", altKey: true }), 1, "QWERTY Alt+1 fires once");
  assert.equal(fires({ key: "¡", code: "Digit1", altKey: true }), 1, "macOS Option+1 fires once");
  assert.equal(fires({ key: "&", code: "Digit1", altKey: true }), 1, "AZERTY: the 1-labeled key fires once, via the printed digit's code");
  assert.equal(fires({ key: "ç", code: "Digit9", altKey: true }), 1, "AZERTY: the 9-labeled key fires once");
  assert.equal(fires({ key: "1", code: "Digit2", altKey: true }), 1, "a mismatched (key, code) pair is still one event");

  /* the AZERTY 1-labeled key means the digit ROW's first key: key "&" is not
     a digit, so e.code decides — and it lands on the same index once */
  assert.equal(workspaceIndexFromChord({ key: "&", code: "Digit1", altKey: true }), 0, "AZERTY: physical Digit1 selects workspace 1");
  assert.equal(workspaceIndexFromChord({ key: "é", code: "Digit2", altKey: true }), 1, "AZERTY: physical Digit2 selects workspace 2");

  /* and the printed digit wins over a mismatched code, so a chord can never
     be counted twice or land on the wrong workspace */
  assert.equal(workspaceIndexFromChord({ key: "3", code: "Digit1", altKey: true }), 2, "the printed digit is the meaning, not the code");
});
