import { test } from "node:test";
import assert from "node:assert/strict";

/* SPEC-TESTS for the settings-page revamp — https://github.com/roowus/truss/issues/30
   ("Better settings page: tabs/organization/TOC maybe; it's messy and
   ineffective right now, with a lack of settings"). These FAIL on purpose
   today: they pin the contract a fix must satisfy.

   Today SettingsPanel.tsx is one 580px scroll of hand-written sections with
   inconsistent controls (Toggle vs Select vs switch vs a Save-button input)
   and inconsistent save semantics (the cwd row has its own Save button,
   everything else auto-saves). Worse, existing settings are MISSING from it
   (groupMode is only reachable from the sidebar), and adjacent config lives
   in scattered panels (credentials, router, cost, hosts).

   The contract: a declarative registry drives the page — pure
   src/lib/settingsRegistry.ts —

     SETTINGS_SECTIONS: { id, label, description }[]
     SETTINGS_REGISTRY: SettingField[]
       SettingField = { id (dotted, unique), section, label, description,
                        type: "switch" | "toggle" | "select" | "text" | "number",
                        options? (select/toggle), default, keywords? }
     searchSettings(query): SettingField[]

   Rules it must honor:
   - coverage: every UiSettings key exists in the registry — density,
     openMode, terminalFontSize, defaultCwd, feedSources.*, AND groupMode
     (the one the current page forgot) — plus the obvious plumbing-ready
     additions the issue lists;
   - integrity: unique ids; every field's section exists; label +
     description on EVERY field (no unexplained settings); select/toggle
     fields declare ≥2 options; defaults match the declared type;
   - search: matches label/description/keywords, case-insensitive; empty
     query returns everything; nonsense returns nothing.

   The page rendering (tabs/TOC, one control family, uniform auto-save) is
   acceptance criteria, not pinned here. */

interface SettingField {
  id: string;
  section: string;
  label: string;
  description: string;
  type: "switch" | "toggle" | "select" | "text" | "number";
  options?: { value: string; label: string }[];
  default: unknown;
  keywords?: string[];
}
interface RegistryModule {
  SETTINGS_SECTIONS: { id: string; label: string; description?: string }[];
  SETTINGS_REGISTRY: SettingField[];
  searchSettings(query: string): SettingField[];
}

async function load(): Promise<RegistryModule | null> {
  const spec = "../src/lib/settingsRegistry"; // variable specifier: typechecks even before the module exists
  return import(spec).catch(() => null);
}

test("src/lib/settingsRegistry.ts exists with sections + fields", async () => {
  const mod = await load();
  assert.ok(mod, "src/lib/settingsRegistry.ts must export SETTINGS_SECTIONS/SETTINGS_REGISTRY/searchSettings — see issue #30");
  assert.ok(mod.SETTINGS_SECTIONS.length >= 4, "a real organization (tabs/TOC), not one pile");
  assert.ok(mod.SETTINGS_REGISTRY.length >= 10, "more settings than today's page, not fewer");
});

test("coverage: every existing setting is in the registry — including the one the page forgot", async () => {
  const mod = await load();
  assert.ok(mod, "registry module must exist (see module test)");
  const ids = new Set(mod.SETTINGS_REGISTRY.map((f) => f.id));
  for (const key of ["density", "openMode", "terminalFontSize", "defaultCwd"]) {
    assert.ok(ids.has(key), `existing setting "${key}" survives the revamp`);
  }
  for (const src of ["permissions", "workDone", "taskRuns", "errors", "context"]) {
    assert.ok(ids.has(`feedSources.${src}`), `feed source "${src}" keeps its toggle`);
  }
  assert.ok(ids.has("groupMode"), "groupMode — the sidebar-only setting the current page FORGOT — is in the registry");

  /* the "lack of settings" half: plumbing already exists for these */
  assert.ok(ids.has("monitorRefreshMs"), "the monitor's hardcoded 3s poll becomes a setting");
  assert.ok(ids.has("trashRetentionDays"), "the 30-day trash window (#5) becomes a setting");
});

test("integrity: unique ids, real sections, explained fields, typed defaults", async () => {
  const mod = await load();
  assert.ok(mod, "registry module must exist (see module test)");
  const sectionIds = new Set(mod.SETTINGS_SECTIONS.map((s) => s.id));
  const seen = new Set<string>();

  for (const s of mod.SETTINGS_SECTIONS) {
    assert.ok(s.label.length > 0, `section ${s.id}: has a label`);
  }
  for (const f of mod.SETTINGS_REGISTRY) {
    assert.ok(!seen.has(f.id), `duplicate field id: ${f.id}`);
    seen.add(f.id);
    assert.ok(sectionIds.has(f.section), `${f.id}: unknown section "${f.section}"`);
    assert.ok(f.label.trim().length > 0, `${f.id}: unlabeled`);
    assert.ok(f.description.trim().length >= 12, `${f.id}: unexplained — every setting says what it does (the core complaint)`);
    if (f.type === "select" || f.type === "toggle") {
      assert.ok((f.options?.length ?? 0) >= 2, `${f.id}: ${f.type} needs ≥2 options`);
      assert.ok(f.options!.some((o) => o.value === (f.default as string)), `${f.id}: default must be one of the options`);
    }
    if (f.type === "switch") assert.equal(typeof f.default, "boolean", `${f.id}: switch default is boolean`);
    if (f.type === "number") assert.equal(typeof f.default, "number", `${f.id}: number default is a number`);
    if (f.type === "text") assert.equal(typeof f.default, "string", `${f.id}: text default is a string`);
  }
});

test("searchSettings: finds by label/description/keywords; empty returns all; nonsense returns none", async () => {
  const mod = await load();
  assert.ok(mod, "registry module must exist (see module test)");

  assert.deepEqual(mod.searchSettings(""), mod.SETTINGS_REGISTRY, "empty query = everything");
  assert.deepEqual(mod.searchSettings("   "), mod.SETTINGS_REGISTRY, "blank query = everything");

  const byLabel = mod.searchSettings("density");
  assert.ok(byLabel.some((f) => f.id === "density"), "label match");
  const byDesc = mod.searchSettings("workspace");
  assert.ok(byDesc.length >= 1, "description match");
  const all = mod.searchSettings("DENSITY");
  assert.ok(all.some((f) => f.id === "density"), "case-insensitive");

  assert.deepEqual(mod.searchSettings("zz-no-such-setting-zz"), [], "no match → empty, never a crash");
});
