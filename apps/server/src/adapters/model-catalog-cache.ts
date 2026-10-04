import { store } from "../db.js";

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
 */

export interface CatalogModel {
  provider: string;
  model: string;
  label: string;
}

function isCatalogModel(m: unknown): m is CatalogModel {
  const o = m as CatalogModel;
  return !!o && typeof o.provider === "string" && typeof o.model === "string" && typeof o.label === "string";
}

export function readCatalogCache(key: string): CatalogModel[] {
  try {
    const raw = store.getKv(key);
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
    store.setKv(key, JSON.stringify(models));
  } catch {
    /* a picker that shows this boot's discovery is still correct — the
       write only matters for the NEXT boot */
  }
}
