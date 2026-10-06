import { test } from "node:test";
import assert from "node:assert/strict";

/* SPEC-TESTS for catalog scope notes — https://github.com/roowus/truss/issues/170
   ("Does claude-code not have the same model selection as the other
   harnesses?"). These pinned the contract the fix had to satisfy; the fix
   landed with them, so they pass.

   Investigated — this is BY DESIGN but invisible: claude's picker lists
   exactly the 11 GLM models the loopback key-proxy serves (verified live:
   GET 127.0.0.1:45821/api/anthropic/v1/models → 11), while pi/hermes read
   600+ from OpenRouter/dsh catalogs. Different credential routes, different
   universes — nothing broken, but the picker never SAYS so, and a sparse
   list reads as a bug.

   The contract: models.ts gains —

     catalogScopeNote(models: { provider: string }[]): string | null

   - all rows one provider → "via <provider>" (claude: "via zai-local — the
     local key-proxy" shape);
   - 2–3 providers → "via a · b · c";
   - many providers → null (the per-row labels from #169 carry it);
   - empty → null. The picker shows the note under the model list when the
     list is scoped, so a short list reads as intentional. */

interface ScopeModule {
  catalogScopeNote(models: { provider: string }[]): string | null;
}

async function load(): Promise<ScopeModule | null> {
  const spec = "../src/lib/models"; // the module exists; the export is the contract
  const mod: any = await import(spec);
  return typeof mod?.catalogScopeNote === "function" ? mod : null;
}

const ZAI = (n: number) => Array.from({ length: n }, () => ({ provider: "zai-local" }));

test("models.ts exports catalogScopeNote", async () => {
  const mod = await load();
  assert.ok(mod, "src/lib/models.ts must export catalogScopeNote — see issue #170");
});

test("one provider → named; few → listed; many → the per-row labels carry it", async () => {
  const mod = await load();
  assert.ok(mod, "catalogScopeNote must exist (see module test)");

  const claude = mod.catalogScopeNote(ZAI(11));
  assert.ok(claude && /zai-local|z\.ai/.test(claude) && /proxy|local/i.test(claude), `claude's list explains itself (got ${JSON.stringify(claude)})`);

  const mixed = mod.catalogScopeNote([{ provider: "zai-local" }, { provider: "openrouter" }, { provider: "custom" }]);
  assert.ok(mixed && mixed.includes("zai-local") && mixed.includes("openrouter"), "a few providers list out");

  const huge = mod.catalogScopeNote([...ZAI(3), ...Array.from({ length: 8 }, (_, i) => ({ provider: `p${i}` }))]);
  assert.equal(huge, null, "a rich catalog needs no note (rows carry providers per #169)");

  assert.equal(mod.catalogScopeNote([]), null, "empty list → nothing to explain");
});

/* audit round 1 (B1): richness is a row count, not a provider count —
   hermes tags its whole 600+ model catalog provider "hermes"
   (apps/server/src/adapters/hermes.ts mapModels), and a long list must
   stay quiet no matter how few providers it names. Also pins the
   single-provider fallback for providers with no known blurb. */
test("a long list stays quiet even from one provider; unknown providers get the plain note", async () => {
  const mod = await load();
  assert.ok(mod, "catalogScopeNote must exist (see module test)");

  const hermes = Array.from({ length: 600 }, () => ({ provider: "hermes" }));
  assert.equal(mod.catalogScopeNote(hermes), null, "600 rows never read as sparse — no note (audit B1)");

  assert.equal(mod.catalogScopeNote([{ provider: "acme" }]), "via acme", "unknown single provider falls back to the bare name");
});
