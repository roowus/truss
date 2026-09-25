/**
 * Model catalog aggregator — queries the enabled dsh-key-proxy routes'
 * /models endpoints (dummy auth; the proxy injects the real keys) and the
 * 9router catalog, cached for 60s. This is what makes harness model pickers
 * rich: the credentials already cover these providers, the pickers just
 * never saw them.
 */

export interface CatalogProvider {
  id: string;
  name: string;
  port: number;
  endpoint: string;
  models: { id: string; context?: number; vision?: boolean; reasoning?: boolean }[];
  error?: string;
}

interface RouteSpec {
  id: string;
  name: string;
  port: number;
  modelsPath: string;
  endpoint: string;
}

/* key-proxy routes that serve OpenAI-compatible /models */
const ROUTES: RouteSpec[] = [
  { id: "fireworks", name: "Fireworks", port: 45820, modelsPath: "/inference/v1/models", endpoint: "http://127.0.0.1:45820/inference/v1" },
  { id: "zai", name: "z.ai", port: 45821, modelsPath: "/api/paas/v4/models", endpoint: "http://127.0.0.1:45821/api/paas/v4" },
  { id: "openrouter", name: "OpenRouter", port: 45823, modelsPath: "/api/v1/models", endpoint: "http://127.0.0.1:45823/api/v1" },
  { id: "huggingface", name: "HuggingFace", port: 45824, modelsPath: "/v1/models", endpoint: "http://127.0.0.1:45824/v1" },
];

let cache: { at: number; providers: CatalogProvider[] } | null = null;
const TTL = 60_000;

const KNOWN_CONTEXT: [RegExp, number][] = [
  [/kimi-k3/i, 1_048_576],
  [/glm-5/i, 200_000],
  [/gemini/i, 1_048_576],
  [/deepseek/i, 160_000],
  [/gpt-oss/i, 131_072],
  [/minimax/i, 200_000],
  [/qwen/i, 262_144],
];

function guessContext(id: string): number {
  for (const [re, n] of KNOWN_CONTEXT) if (re.test(id)) return n;
  return 128_000;
}

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
    const j = (await res.json()) as { data?: { id: string; context_length?: number; capabilities?: Record<string, unknown> }[] };
    const models = (j.data ?? [])
      .filter((m) => typeof m.id === "string" && m.id.length > 0)
      .map((m) => ({
        id: m.id,
        context: m.context_length ?? guessContext(m.id),
        vision: m.capabilities?.vision === true,
        reasoning: m.capabilities?.reasoning === true || /glm|kimi|deepseek|qwen.*think/i.test(m.id),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
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
