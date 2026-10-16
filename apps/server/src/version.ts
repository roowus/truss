import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/* Code identity for /health (issue #135): which commit this server is
   running, so "is the fix live?" is one curl and the mainline watcher can
   tell a restart that took from a squatter still serving the old build.
   Resolved once at boot: TRUSS_COMMIT wins (packaged deploys), otherwise
   ask git from the server's own directory. A deploy with no git reports
   "unknown" — /health must never crash over identity. */
function resolveCommit(): string {
  const fromEnv = process.env.TRUSS_COMMIT?.trim();
  if (fromEnv) return fromEnv;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: here,
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return sha || "unknown";
  } catch {
    return "unknown";
  }
}

export const COMMIT = resolveCommit();

/* The server's own version for the readiness report (issue #219, audit B3).
   Read from THIS package's manifest rather than a literal: a hardcoded
   "0.2.0" reported a version the server was not (apps/server is 0.1.0) and
   would drift on every release. Resolved once at boot; a deploy whose
   manifest cannot be read reports "unknown" rather than crashing — identity
   must never be the reason /api/health fails. */
function resolveVersion(): string {
  const fromEnv = process.env.TRUSS_VERSION?.trim();
  if (fromEnv) return fromEnv;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    /* src/ in dev (tsx) and dist/ in a build both sit one level under the
       package root, so the same relative hop works for both */
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

export const VERSION = resolveVersion();
