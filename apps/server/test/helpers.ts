import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Every server module that touches the DB opens truss.db at import time via
 * TRUSS_DATA_DIR. A test file that needs a fresh, isolated store sets the env
 * var BEFORE dynamically importing the modules under test — static imports
 * hoist, so always `await import()` inside `freshServer()`.
 *
 *   const { db, todos } = await freshServer("todos");
 *   ... test body ...
 *   cleanup();
 *
 * Caveat: only the DB is isolated this way — module-level in-memory state
 * (e.g. hosts.ts's deleted-id tombstones) survives across fixtures in the
 * same file. Modules that keep such state export a reset (see
 * resetHostTombstones); call it when a fixture needs a clean slate.
 */
export interface FreshServer {
  dir: string;
  db: typeof import("../src/db.js");
  cleanup: () => void;
}

export async function freshServer(tag = "misc"): Promise<FreshServer> {
  const dir = mkdtempSync(join(tmpdir(), `truss-test-${tag}-`));
  process.env.TRUSS_DATA_DIR = dir;
  const db = await import("../src/db.js");
  return {
    dir,
    db,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* sqlite may still hold the handle; tmp dirs get reaped anyway */
      }
    },
  };
}

/** pull a fresh copy of a server module after TRUSS_DATA_DIR is set */
export async function loadModule<T>(rel: string): Promise<T> {
  return (await import(rel)) as T;
}

/** crude but deterministic: flush the microtask queue + a macrotask tick */
export const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
