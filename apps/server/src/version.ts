import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
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
