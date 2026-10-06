import { test } from "node:test";
import assert from "node:assert/strict";

/* SPEC-TESTS for the truss model router — the resolver half.
   The router fans one Anthropic-compatible local endpoint out to every
   provider the box can reach (issue: claude pinned to the z.ai route's 11
   GLM models while 9router serves 139 across 14 providers).

   The contract: apps/server/src/router-resolve.ts gains —

     resolveRoute(model: string, catalog: { provider: string; model: string; protocol: "anthropic" | "openai" }[]):
       { provider: string; protocol: "anthropic" | "openai" } | null

   - exact model id match → its provider + protocol;
   - unknown model → null (the caller keeps today's fallback route);
   - the same model id offered by several providers → the catalog's first
     occurrence wins (preference order is the caller's ordering, no
     resolver-side guessing). */

interface ResolveModule {
  resolveRoute(
    model: string,
    catalog: { provider: string; model: string; protocol: "anthropic" | "openai" }[],
  ): { provider: string; protocol: "anthropic" | "openai" } | null;
}

async function load(): Promise<ResolveModule | null> {
  const mod: any = await import("../src/router-resolve.js").catch(() => null);
  return typeof mod?.resolveRoute === "function" ? mod : null;
}

const CATALOG = [
  { provider: "zai", model: "glm-4.7", protocol: "anthropic" as const },
  { provider: "router", model: "glm-4.7", protocol: "openai" as const },
  { provider: "router", model: "deepseek-v3.2", protocol: "openai" as const },
];

test("router-resolve.ts exports resolveRoute", async () => {
  assert.ok(await load(), "apps/server/src/router-resolve.ts must export resolveRoute");
});

test("exact match → provider + protocol; unknown → null; duplicates → first wins", async () => {
  const mod = await load();
  assert.ok(mod, "resolveRoute must exist (see module test)");

  assert.deepEqual(mod.resolveRoute("deepseek-v3.2", CATALOG), { provider: "router", protocol: "openai" });
  assert.deepEqual(mod.resolveRoute("glm-4.7", CATALOG), { provider: "zai", protocol: "anthropic" }, "duplicate id: first catalog occurrence wins");
  assert.equal(mod.resolveRoute("nope-1b", CATALOG), null, "unknown model → caller keeps the fallback route");
  assert.equal(mod.resolveRoute("glm-4.7", []), null, "empty catalog → null");
});
