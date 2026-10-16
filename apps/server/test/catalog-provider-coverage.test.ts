import { test } from "node:test";
import assert from "node:assert/strict";

/* REGRESSION: enabled key-proxy routes were invisible to every model picker.

   The bug (user report: "I can't see any models from DeepSeek, only DeepSeek
   from Fireworks"): the box's key-proxy served an enabled, keyed DeepSeek
   route on :45827, but all THREE tables that decide which routes are ever
   queried were hardcoded and had never learned about it:

     - modelcat.ts    ROUTES                (what /models gets probed)
     - model-router.ts MODEL_ROUTER_PROVIDERS (where a model id fans out)
     - pi-config.ts   PROVIDER_IDS          (which providers land in pi's models.json)

   A route missing from a table is never queried, so its models cannot appear
   in any picker no matter how healthy its key is. That is the whole bug, and
   it is a class of bug, not one provider: DeepInfra (:45826) was missing the
   same way.

   These tests pin the tables against each other so a future route has to
   reach all three, and they pin the field shapes DeepSeek's own API returns
   (context_window + top-level input_modalities) which differ from the
   OpenAI-style routes the parser was originally written for. */

const modelcat: any = await import("../src/modelcat.js");
const { MODEL_ROUTER_PROVIDERS } = await import("../src/model-router.js");
const piConfig: any = await import("../src/pi-config.js");

/* the two providers that were missing; both are confirmed enabled+keyed in
   the live proxy config (~/.dsh/bin/dsh-key-proxy.json) */
const NEWLY_COVERED = ["deepseek", "deepinfra"];

test("every provider the router can dispatch to is also probed by the catalog", () => {
  /* the catalog is what fills pickers; the router is what serves requests.
     A model that the router knows but the catalog never probes is unreachable
     from the UI, and a model the catalog offers but the router can't dispatch
     is a dead row in the picker. */
  const catalogIds = modelcat.PROVIDER_ROUTE_IDS ?? null;
  assert.ok(catalogIds, "modelcat must export its route ids for this cross-check");
  for (const p of MODEL_ROUTER_PROVIDERS) {
    if (p.id === "router") continue; /* 9router is discovered via its own live catalog, not a proxy route */
    assert.ok(catalogIds.includes(p.id), `router dispatches ${p.id} but the catalog never probes it — its models can never appear`);
  }
});

test("DeepSeek and DeepInfra are present in all three tables (the reported gap)", () => {
  const catalogIds = modelcat.PROVIDER_ROUTE_IDS;
  const routerIds = MODEL_ROUTER_PROVIDERS.map((p: { id: string }) => p.id);
  const piIds = piConfig.PROVIDER_ID_MAP;

  for (const id of NEWLY_COVERED) {
    assert.ok(catalogIds.includes(id), `modelcat ROUTES is missing ${id} — its models will never reach a picker`);
    assert.ok(routerIds.includes(id), `MODEL_ROUTER_PROVIDERS is missing ${id} — requests cannot be dispatched to it`);
    assert.ok(piIds[id], `pi PROVIDER_IDS is missing ${id} — pi's models.json will not offer it`);
  }
});

test("the DeepSeek route points at the OpenAI-compatible surface on the proxy port", () => {
  const rows = modelcat.PROVIDER_ROUTE_SPECS;
  const ds = rows.find((r: { id: string }) => r.id === "deepseek");
  assert.ok(ds, "deepseek route spec exists");
  assert.equal(ds.port, 45827, "the live key-proxy DeepSeek port");
  assert.equal(ds.modelsPath, "/v1/models", "DeepSeek serves an OpenAI-shaped /v1/models");
  assert.equal(ds.endpoint, "http://127.0.0.1:45827/v1");

  const route = MODEL_ROUTER_PROVIDERS.find((p: { id: string }) => p.id === "deepseek");
  assert.equal(route?.protocol, "openai");
  assert.equal(route?.openaiChatUrl, "http://127.0.0.1:45827/v1/chat/completions");
});

test("the parser understands DeepSeek's own field shape (context_window, input_modalities)", async () => {
  /* DeepSeek's /v1/models reports context_window and top-level
     input_modalities; the OpenAI-style routes report context_length and a
     capabilities object. Both shapes must parse, or DeepSeek rows show a
     wrong guessed context and lose their vision flag. */
  const deepseekShaped = {
    data: [
      { id: "deepseek-flash", context_window: 1_048_576, input_modalities: ["text", "image"] },
      { id: "deepseek-v4-pro", context_window: 1_048_576, input_modalities: ["text"] },
    ],
  };
  const openaiShaped = { data: [{ id: "some/model", context_length: 32_768, capabilities: { vision: true } }] };

  const parse = modelcat.__parseModelsForTest;
  assert.ok(parse, "modelcat must expose its row parser for this test");

  const ds = parse(deepseekShaped);
  assert.deepEqual(ds.map((m: { id: string }) => m.id), ["deepseek-flash", "deepseek-v4-pro"]);
  assert.equal(ds[0].context, 1_048_576, "context_window is read, not guessed");
  assert.equal(ds[0].vision, true, "input_modalities image → vision");
  assert.equal(ds[1].vision, false, "text-only stays non-vision");
  assert.equal(ds[0].reasoning, true, "deepseek ids are treated as reasoning models");

  const oa = parse(openaiShaped);
  assert.equal(oa[0].context, 32_768, "context_length still wins for OpenAI-style routes");
  assert.equal(oa[0].vision, true, "capabilities.vision still honored");
});
