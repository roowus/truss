import { test } from "node:test";
import assert from "node:assert/strict";

/* SPEC-TESTS for human model labels — https://github.com/roowus/truss/issues/169
   ("Models list as accounts/fireworks/routers/…/kimi-k3 — I appreciate the
   provider info, but parse it: show the model's NAME, the provider
   intuitively, and the full path on click-through"). These FAIL on purpose
   today: they pin the contract a fix must satisfy.

   Today: buildModelOptions (models.ts) passes the catalog label straight
   through — dsh's catalog labels fireworks models with the full routing
   path. The picker row IS the path.

   The contract: models.ts gains —

     modelDisplay(m: { provider: string; model: string; label: string }):
       { name: string; providerLabel: string; fullPath: string }

   - deep router paths (accounts/fireworks/routers/…/kimi-k3) →
     name "Kimi K3", providerLabel "Fireworks", fullPath the whole thing;
   - provider/model ids (google/gemini-3-pro via openrouter) →
     name "Gemini 3 Pro", providerLabel "Google" (the id prefix when the
     provider field is an aggregator);
   - clean catalog labels pass through untouched as the name;
   - the picker option carries all three (name primary; provider as the
     secondary line; the path one click away). */

interface ModelDisplayModule {
  modelDisplay(m: { provider: string; model: string; label: string }): { name: string; providerLabel: string; fullPath: string };
}

async function load(): Promise<ModelDisplayModule | null> {
  const spec = "../src/lib/models"; // the module exists; the export is the contract
  const mod: any = await import(spec);
  return typeof mod?.modelDisplay === "function" ? mod : null;
}

test("models.ts exports modelDisplay", async () => {
  const mod = await load();
  assert.ok(mod, "src/lib/models.ts must export modelDisplay — see issue #169");
});

test("router paths parse: name from the tail, provider from the path, full path kept", async () => {
  const mod = await load();
  assert.ok(mod, "modelDisplay must exist (see module test)");

  const fw = mod.modelDisplay({ provider: "fireworks", model: "accounts/fireworks/routers/allofthem/kimi-k3", label: "accounts/fireworks/routers/allofthem/kimi-k3" });
  assert.equal(fw.name, "Kimi K3", "the NAME is the label — the user's exact complaint");
  assert.equal(fw.providerLabel, "Fireworks", "the provider parses out of the path");
  assert.equal(fw.fullPath, "accounts/fireworks/routers/allofthem/kimi-k3", "the path survives for the click-through");
  assert.ok(!fw.name.includes("/"), "the name is never a path");

  const orx = mod.modelDisplay({ provider: "truss-or", model: "google/gemini-3-pro", label: "google/gemini-3-pro" });
  assert.equal(orx.name, "Gemini 3 Pro", "short ids humanize");
  assert.equal(orx.providerLabel, "Google", "the id's prefix is the provider when the provider field is an aggregator");
});

test("clean labels pass through; garbage never throws", async () => {
  const mod = await load();
  assert.ok(mod, "modelDisplay must exist (see module test)");

  const clean = mod.modelDisplay({ provider: "zai-local", model: "glm-4.7", label: "GLM 4.7 (z.ai via key-proxy)" });
  assert.equal(clean.name, "GLM 4.7 (z.ai via key-proxy)", "a real label is already the name — untouched");
  assert.equal(clean.providerLabel, "zai-local".length > 0 ? clean.providerLabel : "", "provider still shown");

  assert.doesNotThrow(() => mod.modelDisplay({ provider: "", model: "", label: "" }));
  const junk = mod.modelDisplay({ provider: "", model: "x", label: "" });
  assert.ok(junk.name.length > 0, "never a blank row");
});

test("the picker options carry the parsed display (name primary, provider secondary, path a click away)", async () => {
  const mod: any = await import("../src/lib/models.js");
  const opts = mod.buildModelOptions(
    [{ harness: "dsh", provider: "fireworks", model: "accounts/fireworks/routers/x/kimi-k3", label: "accounts/fireworks/routers/x/kimi-k3" }],
    "dsh",
  );
  assert.equal(opts.length, 1);
  assert.equal(opts[0].label, "Kimi K3", "the row's primary text is the parsed name — never the raw path");
  assert.ok(opts[0].providerLabel === "Fireworks", "the provider rides as the secondary line");
  assert.ok(opts[0].fullPath?.includes("accounts/fireworks"), "and the path is one click away");
  assert.equal(opts[0].value, "fireworks/accounts/fireworks/routers/x/kimi-k3", "the VALUE stays the exact id (switching must keep working — the #14 contract)");
});
