/**
 * Model catalog aggregator — queries the enabled dsh-key-proxy routes'
 * /models endpoints (dummy auth; the proxy injects the real keys) and the
 * 9router catalog, cached for 60s. This is what makes harness model pickers
 * rich: the credentials already cover these providers, the pickers just
 * never saw them.
 *
 * The route table is DERIVED from the live key-proxy config (issue #229).
 * It used to be hand-maintained, which meant a route that was enabled and
 * keyed at the proxy but missing from this file was never queried, so its
 * models could not appear in any picker. A missing or malformed config
 * degrades to the old static table (see provider-shapes.ts) rather than
 * emptying every picker.
 */

import { deriveProviderTables, type RouteSpec } from "./provider-shapes.js";

export interface CatalogProvider {
  id: string;
  name: string;
  port: number;
  endpoint: string;
  models: { id: string; context?: number; vision?: boolean; reasoning?: boolean }[];
  error?: string;
}

/* enabled key-proxy routes that serve a /models endpoint, derived from the
   proxy config so a newly added route is visible without a code edit */
const TABLES = deriveProviderTables();
const ROUTES: RouteSpec[] = TABLES.routes;

/* Whether the live tables came from the proxy config or from the static
   fallback. Exposed so boot can SAY which one is in play: a silent fallback
   would be the same invisible-provider bug this change exists to kill. */
export const CATALOG_ROUTES_DERIVED: boolean = TABLES.derived;
export const CATALOG_ROUTE_IDS: readonly string[] = ROUTES.map((r) => r.id);

let cache: { at: number; providers: CatalogProvider[] } | null = null;
const TTL = 60_000;

/* Fallback windows for routes that publish no context metadata at all
   (z.ai's /models returns only id/object/created/owned_by). These are a
   LAST resort — real provider metadata always wins. Kept roughly in sync
   with what the live routes actually serve; `guessContext` is the only
   caller, and every value here was checked against the provider's own
   metadata where that metadata exists. */
const KNOWN_CONTEXT: [RegExp, number][] = [
  [/kimi/i, 1_048_576], // kimi-k3 serves 1M (Fireworks reports 1048576)
  [/glm-5/i, 200_000],
  [/glm-4/i, 128_000], // z.ai glm-4.x family reports 128k
  [/gemini/i, 1_048_576],
  [/deepseek/i, 1_048_576], // DeepSeek V4.x is 1M, not the old 160k
  [/gpt-oss/i, 131_072],
  [/minimax/i, 512_000], // Fireworks minimax-m3 reports 512000
  [/nemotron/i, 262_144],
  [/qwen/i, 262_144],
  [/claude/i, 200_000],
];

function guessContext(id: string): number {
  for (const [re, n] of KNOWN_CONTEXT) if (re.test(id)) return n;
  return 128_000;
}

/* Routes disagree on where (and whether) they publish a context window:
   - Fireworks/OpenRouter/DeepInfra: top-level context_length
   - DeepSeek's own API: context_window
   - HuggingFace: per-provider entries under `providers[]`, best-effort the
     largest live one, since a model is served by several backends
   - z.ai: nothing at all — falls through to the guess table */
interface RawProviderEntry {
  status?: string;
  context_length?: number;
}

interface RawModel {
  id: string;
  context_length?: number;
  context_window?: number;
  capabilities?: Record<string, unknown>;
  input_modalities?: string[];
  architecture?: { input_modalities?: string[] };
  providers?: RawProviderEntry[];
  metadata?: { context_length?: number };
}

/** best-effort window from an HF-style providers[] list: the largest live one */
function contextFromProviders(list: RawProviderEntry[] | undefined): number | undefined {
  if (!Array.isArray(list)) return undefined;
  const live = list.filter((p) => p && (p.status === undefined || p.status === "live") && typeof p.context_length === "number");
  if (!live.length) return undefined;
  return Math.max(...live.map((p) => p.context_length as number));
}

function parseModels(j: { data?: RawModel[] }): { id: string; context: number; vision: boolean; reasoning: boolean }[] {
  return (j.data ?? [])
    .filter((m) => typeof m.id === "string" && m.id.length > 0)
    .map((m) => ({
      id: m.id,
      context:
        m.context_length ??
        m.context_window ??
        m.metadata?.context_length ??
        contextFromProviders(m.providers) ??
        guessContext(m.id),
      vision:
        m.capabilities?.vision === true ||
        m.input_modalities?.includes("image") === true ||
        m.architecture?.input_modalities?.includes("image") === true,
      reasoning: m.capabilities?.reasoning === true || /glm|kimi|deepseek|qwen.*think/i.test(m.id),
    }));
}

/* Test seams: the tables are now derived from the key-proxy config, but the
   cross-check against the router and pi tables stays useful — a derivation
   bug, or a provider whose shape is only half-filled in, would still show up
   as the three tables disagreeing. */
export const PROVIDER_ROUTE_SPECS: readonly RouteSpec[] = ROUTES;
export const PROVIDER_ROUTE_IDS: readonly string[] = ROUTES.map((r) => r.id);
export const __parseModelsForTest = parseModels;
export const __guessContextForTest = guessContext;

async function fetchRoute(r: RouteSpec): Promise<CatalogProvider> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const res = await fetch(`http://127.0.0.1:${r.port}${r.modelsPath}`, {
      headers: { authorization: "Bearer truss-catalog" },
      signal: ctl.signal,
    });
    clearTimeout(t);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = (await res.json()) as { data?: RawModel[] };
    const models = parseModels(j).sort((a, b) => a.id.localeCompare(b.id));
    return { id: r.id, name: r.name, port: r.port, endpoint: r.endpoint, models };
  } catch (err) {
    return { id: r.id, name: r.name, port: r.port, endpoint: r.endpoint, models: [], error: String(err) };
  }
}

export async function modelCatalog(force = false): Promise<CatalogProvider[]> {
  if (!force && cache && Date.now() - cache.at < TTL) return cache.providers;
  const providers = await Promise.all(ROUTES.map(fetchRoute));
  cache = { at: Date.now(), providers };
  return providers;
}

/** flat harness-picker shape: one row per (provider, model) */
export async function catalogForPickers(): Promise<
  { provider: string; providerName: string; model: string; label: string; context: number; endpoint: string }[]
> {
  const providers = await modelCatalog();
  return providers.flatMap((p) =>
    p.models.map((m) => ({
      provider: p.id,
      providerName: p.name,
      model: m.id,
      label: m.id.split("/").pop() ?? m.id,
      context: m.context ?? 128_000,
      endpoint: p.endpoint,
    })),
  );
}
