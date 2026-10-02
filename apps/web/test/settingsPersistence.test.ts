import { test } from "node:test";
import assert from "node:assert/strict";

/* settings save→load round-trip (issue #30 audit, findings B1/B3): the first
   registry-driven settings page SAVED monitorRefreshMs/trashRetentionDays to
   /api/layout but parseSaved rebuilt settings field-by-field without them, so
   both silently reset on every reload — and terminalFontSize accepted any
   number in the UI while parseSaved still whitelisted [11,12,13,14,16], so
   typing 15 saved "successfully" and snapped back to 13. These tests pin the
   round-trip and the clamping. */

// store.ts touches `window` at module scope (see store.test.ts); desktops.ts
// timers use window.setTimeout inside methods called by updateSettings, and
// the save path's toast/notify chain schedules a requestAnimationFrame.
(globalThis as any).window ??= {};
(globalThis as any).window.setTimeout ??= (cb: () => void, _ms?: number) => setTimeout(cb, 0);
(globalThis as any).window.clearTimeout ??= clearTimeout;
(globalThis as any).requestAnimationFrame ??= (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0);
const { parseSaved, desktops, SETTING_BOUNDS } = await import("../src/lib/desktops");

const doc = (settings: Record<string, unknown>) =>
  JSON.stringify({
    version: 2,
    activeId: "main",
    spaces: [{ id: "main", name: "Main", layout: null }],
    hosts: {},
    settings,
  });

test("round-trip: monitorRefreshMs, trashRetentionDays, and a non-whitelisted font size survive save→load", () => {
  desktops.updateSettings({ monitorRefreshMs: 10_000, trashRetentionDays: 7, terminalFontSize: 15 });
  // snapshot() saves state.settings wholesale; the load path is parseSaved
  const saved = doc(desktops.state.settings as unknown as Record<string, unknown>);
  const parsed = parseSaved(saved);
  assert.equal(parsed.settings.monitorRefreshMs, 10_000, "monitor poll interval survives the reload");
  assert.equal(parsed.settings.trashRetentionDays, 7, "trash retention survives the reload");
  assert.equal(parsed.settings.terminalFontSize, 15, "a free-form font size no longer snaps back to 13");
});

test("missing keys fall back to the registry defaults", () => {
  const parsed = parseSaved(doc({ density: "compact" }));
  assert.equal(parsed.settings.monitorRefreshMs, 3000);
  assert.equal(parsed.settings.trashRetentionDays, 30);
  assert.equal(parsed.settings.terminalFontSize, 13);
  assert.equal(parsed.settings.density, "compact");
});

test("out-of-range or junk values are clamped, never adopted", () => {
  const parsed = parseSaved(
    doc({
      monitorRefreshMs: 50, // below the 500ms floor
      trashRetentionDays: 999_999, // above the 365-day ceiling
      terminalFontSize: "huge", // not a number at all
    }),
  );
  assert.equal(parsed.settings.monitorRefreshMs, SETTING_BOUNDS.monitorRefreshMs.min);
  assert.equal(parsed.settings.trashRetentionDays, SETTING_BOUNDS.trashRetentionDays.max);
  assert.equal(parsed.settings.terminalFontSize, SETTING_BOUNDS.terminalFontSize.fallback);
});

test("registry number fields declare the same bounds parseSaved enforces", async () => {
  const { SETTINGS_REGISTRY } = await import("../src/lib/settingsRegistry");
  for (const [id, b] of Object.entries(SETTING_BOUNDS)) {
    const field = SETTINGS_REGISTRY.find((f) => f.id === id);
    assert.ok(field, `${id} is in the registry`);
    assert.equal(field!.min, b.min, `${id} min matches`);
    assert.equal(field!.max, b.max, `${id} max matches`);
    assert.equal(field!.default, b.fallback, `${id} default matches`);
  }
});
