import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* SPEC-TESTS for the Settings table of contents — https://github.com/roowus/truss/issues/211
   ("Add a table-of-contents sidebar for the settings page"). These FAIL on
   purpose today: they pin the contract a fix must satisfy.

   Today (SettingsPanel.tsx): seven sections in one long scroll (Appearance,
   Sessions, Workspaces, Feed, Integrations, Network, Practices) — no
   navigation; you scroll and hunt.

   The contract: src/lib/settingsToc.ts —

     settingsSections(): { id: string; label: string }[]
       — the ONE source of truth for the page's sections (the page renders
         from it and the TOC links it); stable kebab ids, page order;
     activeSectionId(readLine: number, anchors: { id: string; top: number }[]): string
       — scroll-spy: the LAST section whose anchor is at/above the read
         line (the turn-rail rule, #7); above the first → the first;

   and the read-through: SettingsPanel renders the TOC rail + sections carry
   anchor ids. */

interface SettingsTocModule {
  settingsSections(): { id: string; label: string }[];
  activeSectionId(readLine: number, anchors: { id: string; top: number }[]): string;
}

async function load(): Promise<SettingsTocModule | null> {
  const spec = "../src/lib/settingsToc"; // variable specifier: typechecks before the module exists
  return import(spec).catch(() => null);
}

test("src/lib/settingsToc.ts exists with the page's real sections", async () => {
  const mod = await load();
  assert.ok(mod, "src/lib/settingsToc.ts must export settingsSections + activeSectionId — see issue #211");
  const ids = mod.settingsSections().map((s) => s.id);
  assert.deepEqual(
    ids,
    ["appearance", "sessions", "workspaces", "feed", "integrations", "network", "practices"],
    "the page's seven sections, in page order, kebab ids (anchors)",
  );
});

test("scroll-spy: the last section at/above the read line is active", async () => {
  const mod = await load();
  assert.ok(mod, "settingsToc module must exist (see module test)");
  const anchors = [
    { id: "appearance", top: 0 },
    { id: "sessions", top: 300 },
    { id: "workspaces", top: 700 },
    { id: "feed", top: 1100 },
  ];

  assert.equal(mod.activeSectionId(0, anchors), "appearance", "the top → the first section");
  assert.equal(mod.activeSectionId(299, anchors), "appearance");
  assert.equal(mod.activeSectionId(300, anchors), "sessions", "exactly at the anchor → that section");
  assert.equal(mod.activeSectionId(950, anchors), "workspaces", "between anchors → the one above");
  assert.equal(mod.activeSectionId(9999, anchors), "feed", "past the last → the last");
  assert.doesNotThrow(() => mod.activeSectionId(0, []), "empty page never throws");
});

test("read-through: the page renders the TOC rail and its sections carry anchor ids", () => {
  const src = readFileSync(new URL("../src/panels/SettingsPanel.tsx", import.meta.url), "utf8");
  assert.ok(/settingsSections\(/.test(src), "the page renders from the shared section list");
  assert.ok(/id=\{?["'`]?[a-z]/.test(src) && /settings|toc/i.test(src), "sections carry anchor ids the TOC links to");
});
