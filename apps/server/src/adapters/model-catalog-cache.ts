/**
 * Persistence for the lazily discovered ACP model catalogs (issue #101).
 *
 * hermes and dsh learn their model list from session/new responses, so a
 * server restart used to empty the model picker until the first session
 * booted. Every discovery is written to kv (keys `models:<adapter-id>`) and
 * hydrated at module load. The catalog self-heals: the next real session
 * boot overwrites whatever was persisted, so a stale entry never outlives
 * the next discovery.
 *
 * Persistence must never break a spawn or a picker fetch: every failure
 * (db down, junk JSON, schema drift) reads as an empty catalog.
 *
 * The store is SOFT and dynamically imported: db.js opens sqlite at import,
 * which is fine on the server but impossible inside the bundled node-agent
 * (better-sqlite3's native binding cannot bundle — the agent crashed at
 * boot on it, caught in PR #113 preview testing). The agent needs no
 * persistence — every discovery live-reports to the server — so a missing
 * store simply reads as an empty catalog.
 */

interface KvStore {
  getKv(key: string): string | undefined;
  setKv(key: string, value: string): void;
}

let kvStore: KvStore | null = null;
/* the specifier is indirect ON PURPOSE: esbuild cannot analyze it, so the
   agent bundle keeps a runtime import (which fails on the agent — no db.js
   ships — and the catch below reads as memory-only) instead of bundling
   db.js + better-sqlite3. Bundling it was fatal even with a deferred,
   caught init: bindings' failed native probe leaves a broken global
   Error.prepareStackTrace behind, and the next error formatted (the first
   failed dial) kills the process with a phantom __filename crash. */
const dbSpecifier = "../db.js";
const storeReady: Promise<void> = import(dbSpecifier).then(
  (m) => {
    kvStore = m.store as KvStore;
  },
  () => {
    /* no database in this process (the bundled node-agent) — memory-only */
  },
);

export interface CatalogModel {
  provider: string;
  model: string;
  label: string;
}

/* exported for the other tunnel-facing catalog consumer: remote.ts guards
   models.result rows with the same shape check (issue #123, audit B3) */
export function isCatalogModel(m: unknown): m is CatalogModel {
  const o = m as CatalogModel;
  return !!o && typeof o.provider === "string" && typeof o.model === "string" && typeof o.label === "string";
}

export function readCatalogCache(key: string): CatalogModel[] {
  try {
    const raw = kvStore?.getKv(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isCatalogModel);
  } catch {
    return [];
  }
}

export function writeCatalogCache(key: string, models: CatalogModel[]) {
  try {
    kvStore?.setKv(key, JSON.stringify(models));
  } catch {
    /* a picker that shows this boot's discovery is still correct — the
       write only matters for the NEXT boot */
  }
}

/* a failed probe isn't retried on every picker fetch */
const PROBE_COOLDOWN_MS = 30_000;

export interface LazyCatalog {
  /** the catalog as known right now (hydrated from kv at creation) */
  list(): CatalogModel[];
  /** record a fresh discovery (session boot) — updates memory + kv */
  set(models: CatalogModel[]): void;
  /**
   * One-shot catalog probe for adapters that discover models lazily (from
   * session/new responses): `harvest` opens a throwaway session, reads its
   * catalog, closes it again. sessions.listModels calls probe() in the
   * background when the catalog is empty (first boot on a fresh server —
   * issue #101). Resolves true when the catalog changed; never rejects.
   * Concurrent calls share one in-flight harvest; failures cool down.
   */
  probe(): Promise<boolean>;
}

/**
 * The lazy-catalog state machine both ACP adapters share (hermes, dsh) —
 * hydrated cache + persist-on-discover + guarded background probe. Only the
 * harvest (which call carries the catalog, how it parses) is per-adapter.
 */
export function lazyCatalog(key: string, harvest: () => Promise<CatalogModel[]>): LazyCatalog {
  let models = readCatalogCache(key);
  /* the store lands a microtask after module load (the import is dynamic,
     see the header). A catalog created in that window hydrates when it
     lands — picker fetches are HTTP requests, always later than a
     microtask, so a server restart still never shows an empty window. */
  if (!kvStore) {
    void storeReady.then(() => {
      if (!models.length) models = readCatalogCache(key);
    });
  }
  let inflight: Promise<boolean> | null = null;
  let lastProbeAt = 0;
  return {
    list: () => models,
    set(m) {
      models = m;
      writeCatalogCache(key, m);
    },
    probe() {
      if (models.length) return Promise.resolve(false);
      if (inflight) return inflight;
      if (Date.now() - lastProbeAt < PROBE_COOLDOWN_MS) return Promise.resolve(false);
      lastProbeAt = Date.now();
      inflight = (async () => {
        try {
          const found = await harvest();
          if (!found.length) return false;
          models = found;
          writeCatalogCache(key, found);
          return true;
        } catch {
          return false; /* harness missing/wedged — the picker stays on "harness default" */
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    },
  };
}
