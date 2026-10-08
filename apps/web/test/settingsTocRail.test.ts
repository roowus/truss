import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { railEntries, settingsSections } from "../src/lib/settingsToc";

/* railEntries (audit round 2, finding B1 — issue #211): the TOC rail joins
   the shared section list with the sections actually mounted in the page.
   Network/Practices mount late, and a failed netInfo() keeps Network away
   for good — a rail entry whose anchor is absent must come back disabled,
   never a click that silently no-ops. */

test("railEntries: every section enabled when all anchors are present", () => {
  const entries = railEntries(settingsSections().map((s) => s.id));
  assert.deepEqual(
    entries.map((e) => [e.id, e.enabled]),
    settingsSections().map((s) => [s.id, true]),
    "order and labels follow the shared list, all enabled",
  );
});

test("railEntries: a section whose anchor is absent comes back disabled", () => {
  const present = settingsSections().map((s) => s.id).filter((id) => id !== "network");
  const entries = railEntries(present);
  assert.equal(entries.find((e) => e.id === "network")?.enabled, false, "the unmounted section is disabled");
  assert.ok(
    entries.filter((e) => e.id !== "network").every((e) => e.enabled),
    "the rest stay enabled",
  );
});

test("railEntries: empty page disables everything, unknown ids change nothing", () => {
  assert.ok(railEntries([]).every((e) => !e.enabled), "nothing mounted → all disabled");
  assert.equal(railEntries(["bogus"]).length, settingsSections().length, "unknown ids never add rows");
  assert.ok(railEntries(["bogus"]).every((e) => !e.enabled));
});

/* developer feedback on PR #212: no rail heading ("On this page"), and the
   rail floats in the left margin OUTSIDE the centered content column, so the
   rest of the page keeps its exact centering whether the rail shows or not. */
test("read-through: no rail heading; the rail floats left of the centered column", () => {
  const src = readFileSync(new URL("../src/panels/SettingsPanel.tsx", import.meta.url), "utf8");
  assert.ok(!src.includes("On this page"), "the rail has no heading");
  const nav = src.indexOf('aria-label="Settings sections"');
  const col = src.indexOf("max-w-[580px] mx-auto");
  assert.ok(nav !== -1 && col !== -1, "rail and the centered content column both exist");
  assert.ok(nav < col, "the rail renders before/outside the content column — the column's centering never depends on the rail");
});
