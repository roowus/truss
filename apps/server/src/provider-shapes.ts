import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Provider shapes — the single source of truth for what the box knows about
 * each model provider the key-proxy serves (issue #229).
 *
 * Before this: three hand-maintained tables in three different shapes decided
 * which providers exist —
 *
 *   modelcat.ts     ROUTES                  what /models gets probed
 *   model-router.ts MODEL_ROUTER_PROVIDERS  where a model id fans out
 *   pi-config.ts    PROVIDER_IDS            what lands in pi's models.json
 *
 * Nothing kept them in sync with ~/.dsh/bin/dsh-key-proxy.json, and the
 * catalog is built by iterating ROUTES, so a route that is enabled and keyed
 * at the proxy but missing from that table is NEVER QUERIED. Its models
 * cannot appear in any picker no matter how healthy the key is. DeepSeek and
 * DeepInfra both shipped invisible that way (#228 added them by hand; this
 * module is the mechanism fix).
 *
 * Derivation cannot be pure: the proxy config exposes only
 * port/host/description/enabled/key, and the /models paths genuinely differ
 * per provider (Fireworks is /inference/v1/models, z.ai is
 * /api/paas/v4/models, the rest are /v1/models). So the map below carries the
 * shape knowledge, keyed by host, and the config decides which hosts exist.
 *
 * Two rules keep this safe:
 *   - a missing, malformed, or unreadable config degrades to the STATIC
 *     tables exactly as they were, so a config problem can never empty every
 *     picker;
 *   - an enabled route whose host is not in the map WARNS instead of staying
 *     silent, so the next new provider is loud rather than invisible.
 */

/** what the box knows about one provider, independent of its proxy port */
export interface ProviderShape {
  /** stable provider id used by the catalog, the router, and pi */
  id: string;
  /** display name for pickers */
  name: string;
  /** shape of the probe and the dispatch, off the route's own port */
  modelsPath: string;
  /** how the router talks to it */
  protocol: "anthropic" | "openai";
  /** anthropic protocol: base that /v1/messages hangs off */
  anthropicPath?: string;
  /** openai protocol: chat completions path, appended to the route base */
  chatPath?: string;
  /** provider key in pi's models.json, or null when pi never sees it */
  piProviderId: string | null;
}

/**
 * host -> shape. This is the one table to edit when a provider's API shape is
 * unusual; everything else is derived.
 */
export const PROVIDER_SHAPES: Readonly<Record<string, ProviderShape>> = {
  "api.fireworks.ai": {
    id: "fireworks",
    name: "Fireworks",
    modelsPath: "/inference/v1/models",
    protocol: "openai",
    chatPath: "/inference/v1/chat/completions",
    piProviderId: "truss-fw",
  },
  "api.z.ai": {
    id: "zai",
    name: "z.ai",
    modelsPath: "/api/paas/v4/models",
    protocol: "anthropic",
    anthropicPath: "/api/anthropic",
    piProviderId: "truss-zai",
  },
  "openrouter.ai": {
    id: "openrouter",
    name: "OpenRouter",
    modelsPath: "/api/v1/models",
    protocol: "openai",
    chatPath: "/api/v1/chat/completions",
    piProviderId: "truss-or",
  },
  "router.huggingface.co": {
    id: "huggingface",
    name: "HuggingFace",
    modelsPath: "/v1/models",
    protocol: "openai",
    chatPath: "/v1/chat/completions",
    piProviderId: "truss-hf",
  },
  "api.deepinfra.com": {
    id: "deepinfra",
    name: "DeepInfra",
    modelsPath: "/v1/models",
    protocol: "openai",
    chatPath: "/v1/chat/completions",
    piProviderId: "truss-deepinfra",
  },
  "api.deepseek.com": {
    id: "deepseek",
    name: "DeepSeek",
    modelsPath: "/v1/models",
    protocol: "openai",
    chatPath: "/v1/chat/completions",
    piProviderId: "truss-deepseek",
  },
};

/**
 * The 9router route is enabled on this box but is NOT a probed provider: it
 * serves its own live catalog on :20128 rather than a /models endpoint on a
 * key-proxy port, and model-router.ts discovers it separately as `router`
 * (gated on ROUTER_PROXY_PORT). Its loopback host would be ambiguous in a
 * host-keyed map — and its description says "disabled 2026-09-21" while its
 * `enabled` flag is true, which is exactly why state is read from the flag
 * and never from prose.
 */
const NON_PROVIDER_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

const DEFAULT_CONFIG_PATH =
  process.env.DSH_KEY_PROXY_CONFIG ?? join(homedir(), ".dsh", "bin", "dsh-key-proxy.json");

/** the subset of a proxy route this module reads */
interface RouteRaw {
  port?: number;
  host?: string;
  scheme?: string;
  enabled?: boolean;
  description?: string;
  key?: string;
}

/* ── the static tables, as they were hand-maintained before this change ──
   These are the degrade path AND the test's ground truth. They are written
   out literally rather than derived from PROVIDER_SHAPES on purpose: the
   fallback must reproduce today's behaviour byte for byte, and a derivation
   bug must not be able to move it. */

export interface RouteSpec {
  id: string;
  name: string;
  port: number;
  modelsPath: string;
  endpoint: string;
}

export interface RouterProviderSpec {
  id: string;
  label: string;
  protocol: "anthropic" | "openai";
  anthropicBase?: string;
  openaiChatUrl?: string;
}

export const STATIC_ROUTES: readonly RouteSpec[] = [
  { id: "fireworks", name: "Fireworks", port: 45820, modelsPath: "/inference/v1/models", endpoint: "http://127.0.0.1:45820/inference/v1" },
  { id: "zai", name: "z.ai", port: 45821, modelsPath: "/api/paas/v4/models", endpoint: "http://127.0.0.1:45821/api/paas/v4" },
  { id: "openrouter", name: "OpenRouter", port: 45823, modelsPath: "/api/v1/models", endpoint: "http://127.0.0.1:45823/api/v1" },
  { id: "huggingface", name: "HuggingFace", port: 45824, modelsPath: "/v1/models", endpoint: "http://127.0.0.1:45824/v1" },
  { id: "deepinfra", name: "DeepInfra", port: 45826, modelsPath: "/v1/models", endpoint: "http://127.0.0.1:45826/v1" },
  { id: "deepseek", name: "DeepSeek", port: 45827, modelsPath: "/v1/models", endpoint: "http://127.0.0.1:45827/v1" },
];

export const STATIC_ROUTER_PROVIDERS: readonly RouterProviderSpec[] = [
  { id: "zai", label: "z.ai", protocol: "anthropic", anthropicBase: "http://127.0.0.1:45821/api/anthropic" },
  { id: "fireworks", label: "Fireworks", protocol: "openai", openaiChatUrl: "http://127.0.0.1:45820/inference/v1/chat/completions" },
  { id: "openrouter", label: "OpenRouter", protocol: "openai", openaiChatUrl: "http://127.0.0.1:45823/api/v1/chat/completions" },
  { id: "huggingface", label: "HuggingFace", protocol: "openai", openaiChatUrl: "http://127.0.0.1:45824/v1/chat/completions" },
  { id: "deepinfra", label: "DeepInfra", protocol: "openai", openaiChatUrl: "http://127.0.0.1:45826/v1/chat/completions" },
  { id: "deepseek", label: "DeepSeek", protocol: "openai", openaiChatUrl: "http://127.0.0.1:45827/v1/chat/completions" },
];

export const STATIC_PI_PROVIDER_IDS: Readonly<Record<string, string>> = {
  fireworks: "truss-fw",
  zai: "truss-zai",
  openrouter: "truss-or",
  huggingface: "truss-hf",
  deepinfra: "truss-deepinfra",
  deepseek: "truss-deepseek",
};

/**
 * The router's preference order is NOT the catalog's discovery order: z.ai's
 * Anthropic route leads so GLM duplicates pass through untransformed, and the
 * 9router aggregator trails so a direct route always beats the aggregator's
 * alias for the same id (see model-router.ts). Derivation preserves that
 * intent by sorting the same way instead of adopting config file order.
 */
const ROUTER_ORDER = ["zai", "fireworks", "openrouter", "huggingface", "deepinfra", "deepseek"];

/** 9router's dispatch-only entry; not a probed proxy route (see NON_PROVIDER_HOSTS) */
export const ROUTER_AGGREGATOR_ENTRY: RouterProviderSpec = {
  id: "router",
  label: "9router",
  protocol: "openai",
  openaiChatUrl: "http://127.0.0.1:45822/v1/chat/completions",
};

export interface DerivedTables {
  routes: RouteSpec[];
  routerProviders: RouterProviderSpec[];
  piProviderIds: Record<string, string>;
  /** true when a config was read and produced the tables; false on any degrade */
  derived: boolean;
}

export interface DeriveOptions {
  /** config file path; defaults to the live proxy config */
  configPath?: string;
  /** pre-parsed config, for tests that must not touch the filesystem */
  config?: { routes: RouteRaw[] };
  /** warning sink; defaults to console.warn */
  warn?: (message: string) => void;
}

function staticTables(): DerivedTables {
  return {
    routes: STATIC_ROUTES.map((r) => ({ ...r })),
    routerProviders: [...STATIC_ROUTER_PROVIDERS.map((p) => ({ ...p })), { ...ROUTER_AGGREGATOR_ENTRY }],
    piProviderIds: { ...STATIC_PI_PROVIDER_IDS },
    derived: false,
  };
}

function readConfig(path: string): { routes: RouteRaw[] } | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { routes?: unknown };
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.routes)) return null;
    return parsed as { routes: RouteRaw[] };
  } catch {
    /* missing, unreadable, or malformed — all degrade to the static tables */
    return null;
  }
}

/**
 * Derive the three provider tables from the key-proxy config plus the shape
 * map. Pure with respect to its options, so tests inject a config and never
 * read the live file.
 *
 * Ordering is explicit (port for the catalog, ROUTER_ORDER for dispatch, id
 * for pi) so the order routes happen to sit in the config file cannot change
 * table order between restarts.
 */
export function deriveProviderTables(opts: DeriveOptions = {}): DerivedTables {
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const cfg = opts.config ?? readConfig(opts.configPath ?? DEFAULT_CONFIG_PATH);
  if (!cfg) return staticTables();

  const routes: RouteSpec[] = [];
  const routerProviders: RouterProviderSpec[] = [];
  const piProviderIds: Record<string, string> = {};
  const seenHosts = new Map<string, number>();

  /* Sort before deriving, not after: resolving a host collision by its
     config-file position would make the winning port depend on file order.
     Lowest port wins, deterministically, whatever order the file is in. */
  const enabled = cfg.routes
    .filter((r) => r.enabled !== false)
    .slice()
    .sort((a, b) => (a.port ?? 0) - (b.port ?? 0));

  for (const r of enabled) {
    const host = r.host;
    if (typeof host !== "string" || !host) continue;
    if (NON_PROVIDER_HOSTS.has(host)) continue; // 9router and friends: dispatch-only

    const shape = PROVIDER_SHAPES[host];
    if (!shape) {
      /* THE bug class: an enabled, keyed route nobody can see. Loud, and it
         does not stop the other routes from deriving. */
      warn(
        `[provider-shapes] warn: key-proxy route :${r.port} (${host}) is enabled but has no entry in the provider shape map — ` +
          `its models cannot appear in any picker until a shape is added for it`,
      );
      continue;
    }

    const prior = seenHosts.get(host);
    if (prior !== undefined) {
      /* Two ports share a host, so a host-keyed map can only describe one
         shape for both. Lowest port already won (the sort above); name both,
         so the next person sees why one route has no entry. */
      warn(
        `[provider-shapes] warn: key-proxy routes :${prior} and :${r.port} both serve ${host} — ` +
          `they share one shape, so :${r.port} has no entry of its own and keeps whatever the proxy serves on :${prior}`,
      );
      continue;
    }
    seenHosts.set(host, r.port ?? 0);

    const port = r.port as number;
    const base = `http://127.0.0.1:${port}`;
    routes.push({
      id: shape.id,
      name: shape.name,
      port,
      modelsPath: shape.modelsPath,
      endpoint: `${base}${shape.modelsPath.replace(/\/models$/, "")}`,
    });

    const prefix = shape.id === "zai" ? "/api" : shape.anthropicPath ?? "";
    routerProviders.push(
      shape.protocol === "anthropic"
        ? {
            id: shape.id,
            label: shape.name,
            protocol: "anthropic",
            anthropicBase: `${base}${shape.anthropicPath ?? prefix}`,
          }
        : {
            id: shape.id,
            label: shape.name,
            protocol: "openai",
            openaiChatUrl: `${base}${shape.chatPath ?? "/v1/chat/completions"}`,
          },
    );

    if (shape.piProviderId) piProviderIds[shape.id] = shape.piProviderId;
  }

  /* explicit, restart-stable ordering */
  routes.sort((a, b) => a.port - b.port);
  routerProviders.sort((a, b) => {
    const ia = ROUTER_ORDER.indexOf(a.id);
    const ib = ROUTER_ORDER.indexOf(b.id);
    return (ia === -1 ? ROUTER_ORDER.length : ia) - (ib === -1 ? ROUTER_ORDER.length : ib);
  });
  routerProviders.push({ ...ROUTER_AGGREGATOR_ENTRY });

  return { routes, routerProviders, piProviderIds, derived: true };
}
