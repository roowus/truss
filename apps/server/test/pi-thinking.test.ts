import { test } from "node:test";
import assert from "node:assert/strict";

/* SPEC-TESTS for the pi × always-thinking-models 400 —
   https://github.com/roowus/truss/issues/28
   (User report, pi session via zai credentials: `400: {"code":"1210",
   "message":"This model always engages in thinking and cannot be disabled;
   please use low, high, or max"}`). These FAIL on purpose today: they pin
   the contract a fix must satisfy.

   Root cause (evidence in the issue): truss's generated models.json flags
   glm models `reasoning: true` correctly, but writes NO thinkingLevelMap.
   pi's openai-completions transport, when the user hasn't picked an effort
   (the default), sends `model.thinkingLevelMap?.off ?? "none"` — i.e.
   reasoning_effort/thinking = "none" — and zai hard-rejects a disabled
   thinking for always-on models. Fireworks tolerates "none", which is why
   only non-fireworks credentials break.

   The contract: extract the model-entry builder from syncPiModelsJson into
   a pure export from src/pi-config.ts —

     piModelEntry(model: CatalogModel, providerId: string): PiModelEntry
     THINKING_FLOOR: Record<string, string>   // provider → minimum level

   Rules it must honor:
   - reasoning models on a floored provider (zai: "low") get a
     thinkingLevelMap whose EVERY value is accepted by the provider — no
     "none"/"disabled" anywhere, and `off` maps to the floor (the default
     path is the bug);
   - reasoning models on floor-less providers (fireworks) stay as today
     (no map — "none" is legal there);
   - non-reasoning models never gain a map;
   - today's entry fields (id/name/contextWindow/maxTokens/input) are
     preserved unchanged;
   - user-owned providers are out of scope (syncPiModelsJson already skips
     them) — the map only lands on truss-managed providers.

   The pi-side RPC default-level nicety and the eventual #27 effort changer
   are acceptance-criteria territory, not pinned here. */

interface CatalogModelLike {
  id: string;
  context?: number;
  vision?: boolean;
  reasoning?: boolean;
}
interface PiConfigModule {
  THINKING_FLOOR: Record<string, string>;
  piModelEntry(
    model: CatalogModelLike,
    providerId: string,
  ): {
    id: string;
    name: string;
    reasoning: boolean;
    contextWindow: number;
    maxTokens: number;
    input: string[];
    thinkingLevelMap?: Record<string, string>;
  };
}

async function load(): Promise<PiConfigModule | null> {
  const spec = "../src/pi-config.js";
  const mod: any = await import(spec);
  return typeof mod?.piModelEntry === "function" ? mod : null;
}

const GLM = { id: "glm-4.7", reasoning: true, context: 200_000 } satisfies CatalogModelLike;

test("pi-config.ts gains the pure entry builder + the floor table (zai floors at low)", async () => {
  const mod = await load();
  assert.ok(mod, "pi-config.ts must export piModelEntry + THINKING_FLOOR — see issue #28");
  assert.equal(mod.THINKING_FLOOR["truss-zai"], "low", "zai's minimum accepted level, per its own 1210 message");
});

test("reasoning model on a floored provider: thinkingLevelMap present, off→floor, NO disabled values", async () => {
  const mod = await load();
  assert.ok(mod, "piModelEntry must exist (see builder test)");
  const entry = mod.piModelEntry(GLM, "truss-zai");

  assert.ok(entry.thinkingLevelMap, "a map must exist — without it pi sends 'none' by default (the 1210)");
  assert.equal(entry.thinkingLevelMap!.off, "low", "pi's untouched default (off) must land on zai's minimum");
  for (const [level, mapped] of Object.entries(entry.thinkingLevelMap!)) {
    assert.ok(!/^(none|disabled|off)$/i.test(mapped), `${level}→${mapped}: never a disabled value on an always-thinking model`);
    assert.ok(["low", "high", "max"].includes(mapped), `${level}→${mapped}: zai accepts only low/high/max (its 1210 message)`);
  }
});

test("fireworks (no floor) and non-reasoning models stay exactly as today", async () => {
  const mod = await load();
  assert.ok(mod, "piModelEntry must exist (see builder test)");

  const fw = mod.piModelEntry({ id: "accounts/fireworks/models/ember-1", reasoning: true }, "truss-fw");
  assert.equal(fw.thinkingLevelMap, undefined, "fireworks accepts 'none' — don't churn a working provider");

  const plain = mod.piModelEntry({ id: "glm-4.5-flash", reasoning: false }, "truss-zai");
  assert.equal(plain.thinkingLevelMap, undefined, "non-reasoning models have no thinking to map");
});

test("the existing entry fields are preserved unchanged", async () => {
  const mod = await load();
  assert.ok(mod, "piModelEntry must exist (see builder test)");
  const entry = mod.piModelEntry({ id: "glm-4.7", name: undefined, reasoning: true, context: 200_000, vision: true } as any, "truss-zai");
  assert.equal(entry.id, "glm-4.7");
  assert.equal(entry.name, "glm-4.7", "name still falls back to the id tail");
  assert.equal(entry.reasoning, true);
  assert.equal(entry.contextWindow, 200_000);
  assert.equal(entry.maxTokens, 64_000, "context-capped, as today");
  assert.deepEqual(entry.input, ["text", "image"], "vision input list preserved");
});
