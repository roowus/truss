import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* SPEC-TESTS for issue #232 — dsh reported 27 models while its profile
   "configured 113".

   The decisive experiment (dumped raw session/new configOptions over ACP):

     dsh --profile acp --patch config/truss-dsh-acp.yml  -> 27 leaves, all fireworks
     dsh --profile acp                                   ->  3 leaves, deepseek-official

   So the harness reports its configuration faithfully, and TRUSS is that
   configuration: the --patch flag. `config/truss-dsh-acp.yml` carries exactly
   27 hand-written fireworks model entries, and the acp profile never loads
   the web profile's cordis.patch.yml (113 models / 7 providers) — a
   different process on a different profile. The issue's four candidates were
   all wrong; the "27 vs 113" comparison was a category error.

   The agreed design: generate the dsh model catalog from the same live
   key-proxy catalog pi already uses (pi-config.ts), written to a SEPARATE
   file outside the repo tree, passed as a second --patch. The hand-written
   config/truss-dsh-acp.yml is never touched — router.ts reads it for the
   Config panel.

   The contract these tests pin:
     - the generated patch contains every provider+model the credential
       catalog offers, in dsh's llm-pi-ai patch shape
     - it is written OUTSIDE the repo tree (a boot must not dirty git status)
     - generation failure degrades to the static 27, never to an empty catalog
     - the generated file is idempotent (same content -> no rewrite) */

const DATA_DIR = mkdtempSync(join(tmpdir(), "truss-test-dshgen-data-"));
process.env.TRUSS_DATA_DIR = DATA_DIR;

const dshgen: any = await import("../src/dsh-catalog-gen.js");

const CATALOG = [
  {
    id: "fireworks",
    name: "Fireworks",
    port: 45820,
    endpoint: "http://127.0.0.1:45820/inference/v1",
    models: [{ id: "accounts/fireworks/models/kimi-k3" }, { id: "accounts/fireworks/models/glm-5p3" }],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    port: 45827,
    endpoint: "http://127.0.0.1:45827/v1",
    models: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }],
  },
  /* a route with credentials but zero models — the "make it loud" case */
  { id: "zai", name: "z.ai", port: 45821, endpoint: "http://127.0.0.1:45821/api/paas/v4", models: [], error: "ECONNREFUSED" },
];

const row = (provider: string, model: string) => ({ provider, providerName: provider, model, label: model, context: 128000, endpoint: "" });

test("the generated patch carries every provider+model from the credential catalog", () => {
  const rows = CATALOG.flatMap((p: any) => p.models.map((m: any) => row(p.id, m.id)));
  const yml = dshgen.renderDshCatalogPatch(CATALOG, rows);

  for (const m of ["accounts/fireworks/models/kimi-k3", "deepseek-flash", "deepseek-v4-pro"]) {
    assert.ok(yml.includes(m), `generated patch must offer ${m}`);
  }
  /* one provider group per provider that has rows, in dsh patch shape.
     The patch document is a top-level YAML ARRAY (matching
     config/truss-dsh-acp.yml), so the entry is NOT indented. */
  assert.ok(yml.includes("- id: llm-pi-ai"), "the patch must target llm-pi-ai");
  assert.ok(/providers:/.test(yml), "the patch carries a providers map");
  assert.ok(yml.includes("fireworks:") && yml.includes("deepseek:"), "both keyed providers appear as groups");
  assert.ok(!yml.includes("zai:"), "a provider with zero rows must not emit an empty group");
});

test("a model the credential catalog offers is never dropped from the report", () => {
  /* the whole point: the picker must not be narrower than the credentials.
     The observed bug was 27 rows against a much wider credential set. */
  const rows = CATALOG.flatMap((p: any) => p.models.map((m: any) => row(p.id, m.id)));
  const yml = dshgen.renderDshCatalogPatch(CATALOG, rows);
  const offered = (yml.match(/- id:/g) ?? []).length;
  assert.ok(offered >= 4, `all 4 credential models must appear, saw ${offered} -id entries`);
});

test("the generated file is written OUTSIDE the repo tree", () => {
  /* Q3 constraint: a boot-time write inside the repo would dirty git status
     for every worker and the audit. It lands in the runtime data dir. */
  const p = dshgen.generatedPatchPath();
  assert.ok(!p.startsWith(process.cwd()), `generated patch must not live in the repo tree: ${p}`);
  assert.ok(p.includes(DATA_DIR), `generated patch belongs in the runtime data dir: ${p}`);
});

test("generation failure degrades to the static 27, never an empty catalog", async () => {
  /* Q3 constraint: if the key-proxy catalog cannot be fetched, dsh must keep
     reporting the hand-written 27 — a failure must never empty the picker
     (same rule as #229). */
  const orig = dshgen.__sources.modelCatalog;
  dshgen.__sources.modelCatalog = async () => {
    throw new Error("key-proxy down");
  };
  try {
    const r = await dshgen.syncDshCatalogPatch();
    assert.equal(r.ok, false, "a failed generation reports not-ok");
    assert.equal(r.patchPath, "", "no patch path is pointed at on failure, so --patch keeps the static file");
  } finally {
    dshgen.__sources.modelCatalog = orig;
  }
});

test("an all-empty catalog does not blank a previously good generated file", async () => {
  /* routes reachable but every one returned zero models: writing an empty
     providers map would drop dsh to the stock 3 deepseek-official rows */
  const origP = dshgen.__sources.modelCatalog;
  const origR = dshgen.__sources.catalogForPickers;
  dshgen.__sources.modelCatalog = async () => CATALOG.map((p: any) => ({ ...p, models: [] }));
  dshgen.__sources.catalogForPickers = async () => [];
  try {
    const r = await dshgen.syncDshCatalogPatch();
    assert.equal(r.ok, false, "zero rows across every provider is a failure, not a valid empty catalog");
  } finally {
    dshgen.__sources.modelCatalog = origP;
    dshgen.__sources.catalogForPickers = origR;
  }
});

test("a route with credentials but zero rows is surfaced, not hidden", async () => {
  /* Q4: "provider has credentials but zero rows" is a reportable condition.
     Both shapes matter and read differently: a route that ERRORED is an
     outage, a route that answered with an empty list is a config gap. A
     "make it loud" fix has to say which one it is. */
  const rows = CATALOG.flatMap((p: any) => p.models.map((m: any) => row(p.id, m.id)));
  assert.deepEqual(
    dshgen.catalogGaps(CATALOG, rows),
    [{ provider: "zai", reason: "route error: ECONNREFUSED" }],
    "zai's outage is reported as a route error",
  );

  const quiet = [{ id: "zai", name: "z.ai", port: 1, endpoint: "http://z", models: [] }];
  assert.deepEqual(
    dshgen.catalogGaps(quiet as any, []),
    [{ provider: "zai", reason: "no rows" }],
    "an answered-but-empty route reads as no rows",
  );
});

test("generation is idempotent — unchanged content does not rewrite the file", async () => {
  const origP = dshgen.__sources.modelCatalog;
  const origR = dshgen.__sources.catalogForPickers;
  dshgen.__sources.modelCatalog = async () => CATALOG;
  dshgen.__sources.catalogForPickers = async () =>
    CATALOG.flatMap((p: any) => p.models.map((m: any) => row(p.id, m.id)));
  try {
    const first = await dshgen.syncDshCatalogPatch();
    assert.equal(first.ok, true, "generation succeeds against a healthy catalog");
    assert.ok(first.models >= 4, "reports how many models it wrote");
    const second = await dshgen.syncDshCatalogPatch();
    assert.equal(second.wrote, false, "same content must not rewrite (avoids phantom churn)");
  } finally {
    dshgen.__sources.modelCatalog = origP;
    dshgen.__sources.catalogForPickers = origR;
  }
});
