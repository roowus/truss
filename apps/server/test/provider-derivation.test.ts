import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* REGRESSION: issue #229 — the model pickers go blind when a key-proxy route
   is added.

   Three tables decided which providers exist, all hand-maintained:
     - modelcat.ts    ROUTES                 (what /models gets probed)
     - model-router.ts MODEL_ROUTER_PROVIDERS (where a model id fans out)
     - pi-config.ts   PROVIDER_IDS            (what lands in pi's models.json)

   #228 hand-added the two routes that were missing (DeepSeek :45827,
   DeepInfra :45826). That fixed the instances, not the mechanism: the next
   route added to ~/.dsh/bin/dsh-key-proxy.json is invisible in exactly the
   same silent way, because the catalog iterates ROUTES and nothing knows the
   route exists.

   The fix derives all three tables from the live key-proxy config plus a
   host -> shape map (the models path genuinely differs per provider, so pure
   derivation is impossible). These tests pin:

     1. the fallback is BYTE-IDENTICAL to the old hand-maintained tables, for
        a missing, malformed, or unreadable config — pickers must never empty
        because a config file is gone;
     2. derivation is deterministic (explicit sort, so file order cannot
        change table order between restarts);
     3. for the live config the derived tables are SUPERSET-EQUAL to today's
        literals, with the one intentional difference: the second
        openrouter.ai route (:45825, the model-restricted "OpenRouter Jev"
        key) collapses into the host we already probe, loudly. */

const shapes: any = await import("../src/provider-shapes.js");
/* the live modules, to prove they consume the derivation rather than a
   leftover copy of the old table */
const modelcatModule: any = await import("../src/modelcat.js");
const routerModule: any = await import("../src/model-router.js");
const piModule: any = await import("../src/pi-config.js");

/* ── the literal tables as they were before this change ──────────────────
   Copied verbatim from the pre-derivation source; the fallback must equal
   these EXACTLY, because they are what the live box serves today. */
const LITERAL_ROUTES = [
  { id: "fireworks", name: "Fireworks", port: 45820, modelsPath: "/inference/v1/models", endpoint: "http://127.0.0.1:45820/inference/v1" },
  { id: "zai", name: "z.ai", port: 45821, modelsPath: "/api/paas/v4/models", endpoint: "http://127.0.0.1:45821/api/paas/v4" },
  { id: "openrouter", name: "OpenRouter", port: 45823, modelsPath: "/api/v1/models", endpoint: "http://127.0.0.1:45823/api/v1" },
  { id: "huggingface", name: "HuggingFace", port: 45824, modelsPath: "/v1/models", endpoint: "http://127.0.0.1:45824/v1" },
  { id: "deepinfra", name: "DeepInfra", port: 45826, modelsPath: "/v1/models", endpoint: "http://127.0.0.1:45826/v1" },
  { id: "deepseek", name: "DeepSeek", port: 45827, modelsPath: "/v1/models", endpoint: "http://127.0.0.1:45827/v1" },
];

const LITERAL_ROUTER = [
  { id: "zai", label: "z.ai", protocol: "anthropic", anthropicBase: "http://127.0.0.1:45821/api/anthropic" },
  { id: "fireworks", label: "Fireworks", protocol: "openai", openaiChatUrl: "http://127.0.0.1:45820/inference/v1/chat/completions" },
  { id: "openrouter", label: "OpenRouter", protocol: "openai", openaiChatUrl: "http://127.0.0.1:45823/api/v1/chat/completions" },
  { id: "huggingface", label: "HuggingFace", protocol: "openai", openaiChatUrl: "http://127.0.0.1:45824/v1/chat/completions" },
  { id: "deepinfra", label: "DeepInfra", protocol: "openai", openaiChatUrl: "http://127.0.0.1:45826/v1/chat/completions" },
  { id: "deepseek", label: "DeepSeek", protocol: "openai", openaiChatUrl: "http://127.0.0.1:45827/v1/chat/completions" },
  /* 9router is dispatched to but never probed as a key-proxy /models route */
  { id: "router", label: "9router", protocol: "openai", openaiChatUrl: "http://127.0.0.1:45822/v1/chat/completions" },
];

const LITERAL_PI_IDS: Record<string, string> = {
  fireworks: "truss-fw",
  zai: "truss-zai",
  openrouter: "truss-or",
  huggingface: "truss-hf",
  deepinfra: "truss-deepinfra",
  deepseek: "truss-deepseek",
};

/* ── the live proxy config, as read on this box ─────────────────────────── */
const LIVE_CONFIG = {
  routes: [
    { description: "OpenAI", port: 45818, host: "api.openai.com", auth: "bearer", key: "", enabled: false },
    { description: "Anthropic", port: 45819, host: "api.anthropic.com", auth: "x-api-key", key: "", enabled: false },
    { description: "Fireworks", port: 45820, host: "api.fireworks.ai", auth: "bearer", key: "k" },
    { description: "ZAI", port: 45821, host: "api.z.ai", auth: "bearer", key: "k" },
    { description: "Router (local 9router) - disabled 2026-09-21, using OpenRouter direct", port: 45822, scheme: "http", host: "127.0.0.1", upstreamPort: 20128, auth: "bearer", key: "k", enabled: true },
    { description: "OpenRouter", port: 45823, host: "openrouter.ai", auth: "bearer", key: "k" },
    { description: "HuggingFace", port: 45824, host: "router.huggingface.co", auth: "bearer", key: "k", enabled: true },
    { description: "OpenRouter Jev ($20/mo key, jev-only)", port: 45825, host: "openrouter.ai", auth: "bearer", key: "k", allowedModels: ["~typesafe/jev-latest"] },
    { description: "DeepInfra", port: 45826, host: "api.deepinfra.com", auth: "bearer", key: "k", enabled: true },
    { description: "DeepSeek", port: 45827, host: "api.deepseek.com", auth: "bearer", key: "k", enabled: true },
  ],
};

/* a temp config file plus a warning sink — derivation is a pure function of
   (config text, shape map), so tests never touch the real ~/.dsh file */
function withConfig(text: string | null, fn: (api: any) => void) {
  const dir = mkdtempSync(join(tmpdir(), "truss-229-"));
  const path = join(dir, "dsh-key-proxy.json");
  if (text !== null) writeFileSync(path, text);
  const warnings: string[] = [];
  fn({ path, warnings, warn: (m: string) => warnings.push(m) });
}

/* ── 1. the fallback is byte-identical to today's tables ───────────────── */

test("a missing config degrades to exactly today's hand-maintained tables", () => {
  withConfig(null, ({ path, warnings, warn }) => {
    const t = shapes.deriveProviderTables({ configPath: path, warn });
    assert.deepEqual(t.routes, LITERAL_ROUTES, "modelcat ROUTES fallback must be byte-identical");
    assert.deepEqual(t.routerProviders, LITERAL_ROUTER, "MODEL_ROUTER_PROVIDERS fallback must be byte-identical");
    assert.deepEqual(t.piProviderIds, LITERAL_PI_IDS, "PROVIDER_IDS fallback must be byte-identical");
    assert.equal(t.derived, false, "a missing config is not a successful derivation");
    assert.equal(warnings.length, 0, "a missing config is the documented degrade path, not a warning");
  });
});

test("a malformed config degrades to exactly today's tables", () => {
  withConfig("{ this is not json", ({ path, warnings, warn }) => {
    const t = shapes.deriveProviderTables({ configPath: path, warn });
    assert.deepEqual(t.routes, LITERAL_ROUTES);
    assert.deepEqual(t.routerProviders, LITERAL_ROUTER);
    assert.deepEqual(t.piProviderIds, LITERAL_PI_IDS);
    assert.equal(t.derived, false);
    assert.equal(warnings.length, 0, "malformed config degrades quietly to the literals");
  });
});

test("a config with no routes array degrades to exactly today's tables", () => {
  withConfig(JSON.stringify({ notRoutes: [] }), ({ path, warn }) => {
    const t = shapes.deriveProviderTables({ configPath: path, warn });
    assert.deepEqual(t.routes, LITERAL_ROUTES);
    assert.deepEqual(t.routerProviders, LITERAL_ROUTER);
    assert.deepEqual(t.piProviderIds, LITERAL_PI_IDS);
    assert.equal(t.derived, false);
  });
});

test("an unreadable config degrades to exactly today's tables", () => {
  /* chmod 000 is meaningless as root, so make it a DIRECTORY: readFileSync
     then fails with EISDIR for every uid */
  const dir = mkdtempSync(join(tmpdir(), "truss-229-"));
  const path = join(dir, "as-a-directory");
  mkdirSync(path);
  const warnings: string[] = [];
  const t = shapes.deriveProviderTables({ configPath: path, warn: (m: string) => warnings.push(m) });
  assert.deepEqual(t.routes, LITERAL_ROUTES);
  assert.deepEqual(t.routerProviders, LITERAL_ROUTER);
  assert.deepEqual(t.piProviderIds, LITERAL_PI_IDS);
  assert.equal(t.derived, false);
  assert.equal(warnings.length, 0, "an unreadable config is the same degrade path");
});

/* ── 2. derivation is deterministic ────────────────────────────────────── */

test("derivation sorts explicitly so config file order cannot change table order", () => {
  const forward = { routes: [...LIVE_CONFIG.routes] };
  const reversed = { routes: [...LIVE_CONFIG.routes].reverse() };
  const a = shapes.deriveProviderTables({ config: forward, warn: () => {} });
  const b = shapes.deriveProviderTables({ config: reversed, warn: () => {} });
  assert.deepEqual(a.routes, b.routes, "port order in the file must not leak into table order");
  assert.deepEqual(a.routerProviders, b.routerProviders);
  assert.deepEqual(a.piProviderIds, b.piProviderIds);
  assert.equal(a.derived, true);
});

/* ── 3. live config: superset-equal to today, one loud difference ──────── */

test("the live config derives tables superset-equal to today's literals", () => {
  const warnings: string[] = [];
  const t = shapes.deriveProviderTables({ config: LIVE_CONFIG, warn: (m: string) => warnings.push(m) });
  assert.equal(t.derived, true, "the live config parses");

  /* every literal route is still present, unchanged in shape */
  for (const lit of LITERAL_ROUTES) {
    const got = t.routes.find((r: any) => r.id === lit.id);
    assert.ok(got, `derived ROUTES lost ${lit.id}`);
    assert.deepEqual(got, lit, `${lit.id} changed shape — runtime behaviour must not move`);
  }
  for (const lit of LITERAL_ROUTER) {
    const got = t.routerProviders.find((p: any) => p.id === lit.id);
    assert.ok(got, `derived MODEL_ROUTER_PROVIDERS lost ${lit.id}`);
    assert.deepEqual(got, lit, `${lit.id} changed shape`);
  }
  for (const [id, pid] of Object.entries(LITERAL_PI_IDS)) {
    assert.equal(t.piProviderIds[id], pid, `pi provider id for ${id} changed`);
  }

  /* the router keeps its 9router entry, which is not a probed proxy route */
  assert.ok(t.routerProviders.some((p: any) => p.id === "router"), "9router dispatch entry survives derivation");

  /* no extra routes beyond the literals: the disabled routes stay out, the
     loopback 9router route stays out, and :45825 collapses into openrouter */
  for (const r of t.routes) {
    assert.ok(LITERAL_ROUTES.some((l) => l.id === r.id), `unexpected derived route ${r.id}`);
  }
});

test("the second openrouter.ai route collapses loudly, naming both ports", () => {
  const warnings: string[] = [];
  const t = shapes.deriveProviderTables({ config: LIVE_CONFIG, warn: (m: string) => warnings.push(m) });

  /* one entry, not two: :45823 and :45825 share a host, so a host-keyed shape
     map can only describe one shape for both */
  assert.equal(t.routes.filter((r: any) => r.id === "openrouter").length, 1);
  assert.equal(t.routes.find((r: any) => r.id === "openrouter").port, 45823, "the unrestricted route keeps the id");

  const collapse = warnings.find((w) => w.includes("45825"));
  assert.ok(collapse, "the collapse must warn, naming the shadowed port");
  assert.ok(collapse!.includes("45823"), "the warning names the port that kept the id");
  assert.match(collapse!, /openrouter\.ai/, "the warning names the host");
});

test("an enabled route on an unmapped host warns instead of staying silent", () => {
  const warnings: string[] = [];
  const cfg = {
    routes: [
      { description: "Fireworks", port: 45820, host: "api.fireworks.ai", auth: "bearer", key: "k" },
      { description: "Brand New", port: 45999, host: "api.brandnew.example", auth: "bearer", key: "k" },
    ],
  };
  const t = shapes.deriveProviderTables({ config: cfg, warn: (m: string) => warnings.push(m) });

  const w = warnings.find((x) => x.includes("api.brandnew.example"));
  assert.ok(w, "an enabled, keyed, unmapped host must be loud — that is the whole bug class");
  assert.match(w!, /45999/, "the warning names the port");
  assert.match(w!, /warn/i, "it reads as a warning");

  /* the mapped route still derives, so one unknown host cannot blind the rest */
  assert.ok(t.routes.some((r: any) => r.id === "fireworks"), "a known host still derives alongside the unknown one");
  assert.ok(!t.routes.some((r: any) => r.port === 45999), "an unmapped host has no models path, so no route");
});

test("a disabled route is skipped without warning — enabled is the only flag that counts", () => {
  const warnings: string[] = [];
  const cfg = {
    routes: [
      { description: "OpenAI", port: 45818, host: "api.openai.com", auth: "bearer", key: "", enabled: false },
      { description: "Fireworks", port: 45820, host: "api.fireworks.ai", auth: "bearer", key: "k" },
    ],
  };
  const t = shapes.deriveProviderTables({ config: cfg, warn: (m: string) => warnings.push(m) });
  assert.ok(!t.routes.some((r: any) => r.id === "openai"), "a disabled route is not probed");
  assert.equal(warnings.length, 0, "a disabled route is an intentional state, not a warning");
});

test("the 9router loopback route is not probed, even though it is enabled", () => {
  /* its description claims "disabled 2026-09-21" but enabled is TRUE — the
     description is prose and must never be parsed for state. It stays out of
     the probed tables because it serves its own live catalog, not /models on
     a key-proxy port; the router dispatches to it as `router`. */
  const t = shapes.deriveProviderTables({ config: LIVE_CONFIG, warn: () => {} });
  assert.ok(!t.routes.some((r: any) => r.port === 45822), "the loopback 9router route is not a probed provider");
  assert.ok(t.routerProviders.some((p: any) => p.id === "router"), "but the router still dispatches to it");
  assert.ok(!t.piProviderIds.router, "9router is not a pi provider");
});

test("the shape map is the single source of the per-provider knowledge", () => {
  /* the three tables disagreeing by hand was the bug; they must now all come
     from one table. The map is keyed by HOST because that is what the proxy
     config exposes and what decides the API shape — the port is incidental
     (and :45823/:45825 prove a host can carry two). */
  assert.ok(shapes.PROVIDER_SHAPES, "the host -> shape map is exported");
  const byId = new Map<string, any>();
  for (const [host, shape] of Object.entries<any>(shapes.PROVIDER_SHAPES)) {
    assert.equal(typeof host, "string");
    assert.ok(host.includes("."), `${host} looks like a hostname`);
    byId.set(shape.id, shape);
  }
  for (const [id, piId] of Object.entries(LITERAL_PI_IDS)) {
    const shape = byId.get(id);
    assert.ok(shape, `${id} missing from the shape map`);
    assert.equal(shape.piProviderId, piId, `${id} pi id must come from the map`);
  }
  /* the three shapes must agree with the static tables, or the fallback and
     the derived path would describe different boxes */
  for (const lit of LITERAL_ROUTES) {
    const shape = byId.get(lit.id);
    assert.equal(shape.modelsPath, lit.modelsPath, `${lit.id} models path must agree between map and literal`);
  }
});

/* ── 4. the live modules actually consume the derivation ───────────────── */

test("the live catalog reports whether it derived, so a silent fallback is visible at boot", () => {
  /* The fallback is the safe path, but a SILENT fallback is the same bug
     class this issue is about: the box would quietly serve the static table
     and a newly added proxy route would be invisible again with no signal.
     Boot logs which one is in play from these exports.
     Deliberately not asserting the ids themselves: this test must hold on a
     box whose proxy config differs from this one. */
  const modelcat: any = modelcatModule;
  assert.equal(typeof modelcat.CATALOG_ROUTES_DERIVED, "boolean", "boot needs to know which path is live");
  assert.ok(Array.isArray(modelcat.CATALOG_ROUTE_IDS), "and which routes it ended up with");
  assert.ok(modelcat.CATALOG_ROUTE_IDS.length > 0, "whatever the config, the catalog is never emptied");
  assert.deepEqual(
    [...modelcat.CATALOG_ROUTE_IDS],
    [...modelcat.PROVIDER_ROUTE_IDS],
    "the logged ids must be the routes actually probed",
  );
});

test("the three live tables agree with each other after derivation", () => {
  /* the #228 cross-check, restated against the DERIVED tables: derivation
     must not be able to split them apart either */
  const modelcat: any = modelcatModule;
  for (const p of routerModule.MODEL_ROUTER_PROVIDERS) {
    if (p.id === "router") continue; // 9router is discovered via its own live catalog
    assert.ok(modelcat.PROVIDER_ROUTE_IDS.includes(p.id), `router dispatches ${p.id} but the catalog does not probe it`);
    assert.equal(
      piModule.PROVIDER_ID_MAP[p.id],
      shapes.PROVIDER_SHAPES[Object.keys(shapes.PROVIDER_SHAPES).find((h) => shapes.PROVIDER_SHAPES[h].id === p.id)!]
        ?.piProviderId ?? undefined,
      `${p.id} pi id must match the shape map`,
    );
  }
});
