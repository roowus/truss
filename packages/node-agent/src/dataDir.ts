import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The agent's data dir (found in PR #126 preview testing).
 *
 * Adapters persist per-session state under TRUSS_DATA_DIR (pi keeps session
 * transcripts there for resume). The adapter-side fallback default is
 * REPO-relative (apps/server/data) — right on the server, where the
 * adapters live in the monorepo, but the bundled agent has no repo:
 * import.meta.url is ~/.truss/node-agent.mjs there, so the fallback escapes
 * to <home>/../data — /Users/data on a Mac, root-owned, and the first
 * remote pi spawn died on EACCES mkdir. The agent's data home is the
 * install dir itself: ~/.truss. An explicit TRUSS_DATA_DIR always wins.
 */
export function applyDataDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  if (!env.TRUSS_DATA_DIR) env.TRUSS_DATA_DIR = join(home, ".truss");
  return env.TRUSS_DATA_DIR;
}
