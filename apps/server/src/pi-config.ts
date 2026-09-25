import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { modelCatalog } from "./modelcat.js";

/**
 * pi's model picker lives in ~/.pi/agent/models.json — a static file read at
 * spawn. To make it as rich as the credentials allow, Truss regenerates the
 * truss-managed providers in it from the live key-proxy catalog on boot.
 * User-owned providers (anything not truss-*) are left untouched; a one-time
 * backup sits at models.json.pre-truss.
 */

const PI_MODELS = join(homedir(), ".pi", "agent", "models.json");

const PROVIDER_IDS = { fireworks: "truss-fw", zai: "truss-zai", openrouter: "truss-or", huggingface: "truss-hf" } as const;

export async function syncPiModelsJson(): Promise<{ providers: number; models: number }> {
  const catalog = await modelCatalog();
  let cfg: { providers: Record<string, unknown> } = { providers: {} };
  if (existsSync(PI_MODELS)) {
    try {
      cfg = JSON.parse(readFileSync(PI_MODELS, "utf8"));
    } catch {
      /* malformed — start clean but keep a backup */
    }
    const bak = PI_MODELS + ".pre-truss";
    if (!existsSync(bak)) {
      try {
        copyFileSync(PI_MODELS, bak);
      } catch {
        /* best effort */
      }
    }
  }
  cfg.providers ??= {};

  let count = 0;
  for (const p of catalog) {
    const pid = PROVIDER_IDS[p.id as keyof typeof PROVIDER_IDS];
    if (!pid) continue;
    if (!p.models.length) continue; // keep a previously-good list rather than blank it on a route error
    cfg.providers[pid] = {
      baseUrl: p.endpoint,
      api: "openai-completions",
      apiKey: "truss-key-proxy",
      models: p.models.map((m) => ({
        id: m.id,
        name: m.id.split("/").pop() ?? m.id,
        reasoning: m.reasoning ?? false,
        contextWindow: m.context ?? 128_000,
        maxTokens: Math.min(m.context ?? 128_000, 64_000),
        input: m.vision ? ["text", "image"] : ["text"],
      })),
    };
    count += p.models.length;
  }
  mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
  writeFileSync(PI_MODELS, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  return { providers: Object.keys(PROVIDER_IDS).filter((k) => cfg.providers[PROVIDER_IDS[k as keyof typeof PROVIDER_IDS]]).length, models: count };
}
