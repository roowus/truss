/**
 * Route resolver for the truss model router (issue #188) — the pure half.
 * Given a model id and the aggregated catalog, it answers which provider
 * route the request fans out to and which protocol that route speaks.
 *
 * Deliberately dumb: no fuzzy matching, no provider guessing. The catalog's
 * order IS the preference order (the caller lists z.ai's Anthropic route
 * first so duplicate ids pass through untransformed); an unknown id returns
 * null so the caller can keep today's fallback route.
 */

export type RouteProtocol = "anthropic" | "openai";

export interface RouteCatalogEntry {
  provider: string;
  model: string;
  protocol: RouteProtocol;
}

export interface ResolvedRoute {
  provider: string;
  protocol: RouteProtocol;
}

export function resolveRoute(model: string, catalog: RouteCatalogEntry[]): ResolvedRoute | null {
  if (!model) return null;
  const hit = catalog.find((e) => e.model === model);
  return hit ? { provider: hit.provider, protocol: hit.protocol } : null;
}

/* ── the rollout gate (issue #188, step 3) ──────────────────────────────
   Kept here, not in model-router.ts: the claude adapter is bundled into
   remote node-agents, and these three helpers must stay dependency-free so
   the bundle never drags the frontend's server code in. Read LAZILY (every
   call) — module-scope env reads freeze before a remote agent's --server
   derivation runs (issue #100, audit item 16). */

/** env-gated rollout: with TRUSS_MODEL_ROUTER unset, claude rides its
    direct z.ai route exactly as today */
export function modelRouterEnabled(): boolean {
  const v = process.env.TRUSS_MODEL_ROUTER;
  return v === "1" || v === "true" || v === "on";
}

export function modelRouterPort(): number {
  return Number(process.env.TRUSS_MODEL_ROUTER_PORT ?? 45826);
}

/** the frontend speaks the Anthropic API at its root — no path prefix */
export function modelRouterBaseUrl(): string {
  return `http://127.0.0.1:${modelRouterPort()}`;
}
