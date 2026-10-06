import { test } from "node:test";
import assert from "node:assert/strict";
import { freshServer } from "./helpers.js";

/* SPEC-TESTS for the pairing landing page's UI — https://github.com/roowus/truss/issues/164
   ("The site you land on to download truss: the truss logo is completely
   wrong, the copy-command box overflows, the UI is kind of bad"). They pin
   the contract the fix satisfies — written red-first (verified failing
   before the fix landed, green after).

   Investigated (installer.ts pairingPage, served at /p):
   1. WRONG LOGO: the page hand-rolls a triangle-with-crossbars svg
      (viewBox 24×24) — the app's real TrussLogo (ui.tsx) is the
      baseline+zigzag truss shape (viewBox 32×20, two paths). Brand
      mismatch on the one page a new device sees first.
   2. THE COPY BOX OVERFLOWS: `.cmd code { flex: 1 }` with no
      `min-width: 0` — a long command (an unbreakable flex child) forces
      the box past the card. Textbook flexbox overflow.

   The contract (pairingPage() is a pure string — no server needed):
   - the brand svg carries the canonical TrussLogo paths;
   - the command box CSS carries the min-width:0 + overflow rule;
   - the page stays self-contained + dark + mobile-sane (viewport meta). */

async function page(): Promise<string | null> {
  const { cleanup } = await freshServer("pair-page");
  try {
    const mod: any = await import("../src/installer.js");
    return typeof mod.pairingPage === "function" ? mod.pairingPage() : null;
  } finally {
    cleanup();
  }
}

/* the canonical logo's path data (ui.tsx TrussLogo — the app's brand) */
const LOGO_BASELINE = "M1 18h30M3 3h26";
const LOGO_ZIGZAG = "M1 18L6 3l5 15 5-15 5 15 5-15 5 15";

test("the /p page carries the REAL Truss logo, not a hand-rolled triangle", async () => {
  const html = await page();
  assert.ok(html, "installer.ts must keep exporting pairingPage — see issue #164");
  assert.ok(html.includes(LOGO_BASELINE) && html.includes(LOGO_ZIGZAG), "the brand svg is the app's TrussLogo (baseline + zigzag), not the wrong triangle-with-crossbars glyph");
});

test("the copy-command box cannot overflow (min-width:0 + scrollable code)", async () => {
  const html = await page();
  assert.ok(html, "pairingPage must exist (see logo test)");
  assert.ok(/\.cmd\s+code\s*\{[^}]*min-width:\s*0/.test(html), "the flex child carries min-width:0 — today it forces the box past the card edge");
  assert.ok(/\.cmd\s+code\s*\{[^}]*overflow-x:\s*auto/.test(html), "long commands scroll inside the box, never overflow it");
  /* regression pin (audit round 2, B1): .cmd code shrinking is not enough —
     the step wrapper div is itself a flex item, and with the default
     min-width:auto it tracks the widest content, so the overflow just moves
     up a level (found in a real browser with the code rule already green) */
  assert.ok(/\.step\s*>\s*div\s*\{[^}]*min-width:\s*0/.test(html), "the step wrapper flex item also carries min-width:0 — without it the overflow moves up a level and the box still spills past the card");
});

test("the page stays self-contained + sane (viewport, dark, no external deps)", async () => {
  const html = await page();
  assert.ok(html, "pairingPage must exist (see logo test)");
  assert.match(html, /name="viewport"/, "mobile-sane");
  assert.ok(!/src="http|href="http/.test(html), "no external assets — it must render on a bare tailnet device");
  assert.match(html, /color-scheme:\s*dark/, "dark, matching the app");
});
