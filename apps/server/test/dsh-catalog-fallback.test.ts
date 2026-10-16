import { test } from "node:test";
import assert from "node:assert/strict";

/* REGRESSION: the dsh picker froze on a stale, narrow model catalog.

   Seen live: dsh offered 27 all-Fireworks models while pi offered 828, even
   though dsh's own profile (/opt/dsh/profiles/web/cordis.patch.yml) configured
   113 models across 7 providers.

   Why it happened: dsh's list is whatever the HARNESS reports over ACP
   (session/new -> configOptions.model), cached in kv as `models:dsh`. Nothing
   cross-checked it against the credentials the box actually has, and
   sessions.listModels only re-probes when the catalog is EMPTY — so a
   non-empty-but-stale 27-row cache was never repaired. pi was unaffected
   because Truss generates pi's list itself from the key-proxy catalog.

   These tests pin the fallback's merge rules. They are deliberately narrow:
   the patch widens a stale report with the credential catalog, and must NOT
   disturb a healthy report or drop the harness's own labels. The structural
   fix is tracked in docs/reports/2026-10-15-dsh-stale-model-catalog.md. */

const { mergeCatalogRows, catalogLooksStale } = await import("../src/adapters/dsh.js");

interface Row {
  provider: string;
  model: string;
  label: string;
}

const row = (provider: string, model: string, label = model): Row => ({ provider, model, label });

test("a stale report is topped up with the credential catalog", () => {
  /* the observed failure shape: 27 rows, all one provider */
  const reported: Row[] = Array.from({ length: 27 }, (_, i) => row("fireworks", `accounts/fireworks/models/m${i}`));
  const extra = [row("deepseek", "deepseek-flash"), row("deepinfra", "some/model")];

  assert.equal(catalogLooksStale(reported), true, "27 rows is below the staleness floor");
  const merged = mergeCatalogRows(reported, extra);
  assert.equal(merged.length, 29, "credential rows are appended");
  assert.ok(merged.some((m) => m.provider === "deepseek"), "DeepSeek appears after the merge");
});

test("a healthy report is left completely alone", () => {
  /* the other half of the contract: once dsh reports a full catalog, the
     patch must be invisible — no cross-provider expansion, no reordering */
  const reported: Row[] = Array.from({ length: 113 }, (_, i) => row("fireworks", `accounts/fireworks/models/m${i}`));
  assert.equal(catalogLooksStale(reported), false, "113 configured models is a healthy report");
});

test("merge dedupes on provider+model and keeps the harness's rows first", () => {
  const reported = [row("deepseek", "deepseek-flash", "DeepSeek V4.1 Flash (official)")];
  /* same model id from the credential catalog, different label spelling */
  const merged = mergeCatalogRows(reported, [
    row("deepseek", "deepseek-flash", "deepseek-flash"),
    row("deepseek", "deepseek-v4-pro"),
  ]);

  assert.equal(merged.length, 2, "the duplicate (provider, model) pair collapses");
  assert.equal(merged[0].label, "DeepSeek V4.1 Flash (official)", "the harness's own label survives");
  assert.equal(merged[0].provider, "deepseek");
  /* same model id under a DIFFERENT provider is not a duplicate */
  const crossProvider = mergeCatalogRows([row("fireworks", "deepseek-v4-pro")], [row("deepseek", "deepseek-v4-pro")]);
  assert.equal(crossProvider.length, 2, "provider is part of the identity");
});

test("an empty report still triggers the fallback (fresh server, no discovery yet)", () => {
  assert.equal(catalogLooksStale([]), true, "an empty catalog must fall back, not stay empty");
  const merged = mergeCatalogRows([], [row("zai", "glm-5")]);
  assert.deepEqual(merged, [row("zai", "glm-5")]);
});

test("the staleness floor sits below dsh's configured provider count", () => {
  /* The floor is a heuristic, not a fact about dsh. It has to be low enough
     that a badly-truncated report (the observed 27) triggers the fallback,
     and high enough that a legitimately small curated list is not spammed
     with every credential row. dsh's profile configures 113 models, so the
     floor must sit well under that. */
  const configuredModels = 113;
  assert.ok(catalogLooksStale(Array.from({ length: 27 }, () => row("fireworks", "x"))), "the observed 27 triggers it");
  assert.ok(!catalogLooksStale(Array.from({ length: configuredModels }, () => row("fireworks", "x"))), "the real config does not");
});
