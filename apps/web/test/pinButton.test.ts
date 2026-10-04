import { test } from "node:test";
import assert from "node:assert/strict";

/* SPEC-TESTS for the pin button being the indicator —
   https://github.com/roowus/truss/issues/99
   ("Better pin SVG; and the pin button shouldn't be a button AND an
   indicator — the button IS the indicator: solid + always visible when
   pinned (click to unpin), hollow + hover-only when not"). These FAIL on
   purpose today.

   Today's row carries both: a static always-visible amber pin Icon next to
   the title (Sidebar.tsx:226) AND a hover-only pin IconBtn in the action row
   (Sidebar.tsx:~241). Two glyphs, one meaning.

   The contract:

   1. src/lib/pinAffordance.ts — one descriptor for the single affordance:

        pinAffordance(pinned: boolean) →
          { icon: "pinSolid" | "pin"; visible: "always" | "hover"; actionLabel: string }

      pinned   → { icon: "pinSolid", visible: "always", actionLabel: /unpin/i }
      unpinned → { icon: "pin",      visible: "hover",  actionLabel: /pin/i  }
      (one descriptor = one element per row — the static indicator span is
      gone by construction)

   2. the icon registry (extracted to src/lib/icons.ts from ui.tsx's private
      record) ships BOTH pin variants, and they're honestly different: the
      solid one fills (fill="currentColor"), the outline one strokes —
      today there's a single hand-rolled stroke glyph doing both jobs. */

interface PinAffordanceModule {
  pinAffordance(pinned: boolean): {
    icon: "pinSolid" | "pin";
    visible: "always" | "hover";
    actionLabel: string;
  };
}
interface IconsModule {
  ICON_PATHS: Record<string, { path: string; fill?: boolean }>;
}

async function loadAffordance(): Promise<PinAffordanceModule | null> {
  const spec = "../src/lib/pinAffordance"; // variable specifier: typechecks before the module exists
  return import(spec).catch(() => null);
}
async function loadIcons(): Promise<IconsModule | null> {
  const spec = "../src/lib/icons"; // variable specifier: typechecks before the module exists
  return import(spec).catch(() => null);
}

test("pinAffordance: pinned = solid + always-visible + unpin action; unpinned = outline + hover + pin action", async () => {
  const mod = await loadAffordance();
  assert.ok(mod, "src/lib/pinAffordance.ts must export pinAffordance — see issue #99");

  const on = mod.pinAffordance(true);
  assert.equal(on.icon, "pinSolid", "pinned reads SOLID");
  assert.equal(on.visible, "always", "pinned state never hides — it IS the indicator");
  assert.match(on.actionLabel, /unpin/i, "the click undoes it");

  const off = mod.pinAffordance(false);
  assert.equal(off.icon, "pin", "unpinned reads hollow");
  assert.equal(off.visible, "hover", "unpinned only appears on hover");
  assert.match(off.actionLabel, /^pin\b/i, "the click pins");
});

test("one descriptor per row — the indicator and the button are the same element", async () => {
  const mod = await loadAffordance();
  assert.ok(mod, "pinAffordance module must exist (see affordance test)");
  /* structural: the function returns ONE descriptor, so a row can only ever
     render one pin affordance — the two-glyph row can't come back */
  assert.ok(!Array.isArray(mod.pinAffordance(true)), "singular");
  assert.ok(!Array.isArray(mod.pinAffordance(false)), "singular");
});

test("the icon registry ships honest solid + outline pins", async () => {
  const icons = await loadIcons();
  assert.ok(icons, "src/lib/icons.ts must export ICON_PATHS (extracted from ui.tsx) — see issue #99");

  const outline = icons.ICON_PATHS["pin"];
  const solid = icons.ICON_PATHS["pinSolid"];
  assert.ok(outline?.path, "an outline pin exists");
  assert.ok(solid?.path, "a SOLID pin exists — today's single stroke glyph does both jobs badly");
  assert.notEqual(solid.path, outline.path, "the variants genuinely differ");
  assert.equal(solid.fill, true, "the solid variant fills (fill=currentColor)");
  assert.ok(!outline.fill, "the outline variant strokes");
});
