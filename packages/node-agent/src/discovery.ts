import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Directory discovery for the hello announcement (issue #123): a connected
 * host should offer a sensible working directory for the New Session dialog
 * instead of leaving the server to guess from ITS OWN recents.
 *
 * The pure half (suggestCwds) is pinned by
 * apps/server/test/remote-discovery.test.ts: home always leads (the
 * universal fallback), the projects-family dirs that ACTUALLY EXIST follow,
 * nothing is duplicated. The agent checks the filesystem; the server never
 * suggests a dir that isn't there.
 */

/* the projects family, in preference order after home itself */
const PROJECTS_FAMILY = ["projects", "code", "Developer"];

export function suggestCwds(input: { home: string; existing: string[] }): string[] {
  const have = new Set(input.existing);
  const out: string[] = [];
  const push = (dir: string) => {
    if (!out.includes(dir)) out.push(dir);
  };
  push(input.home);
  for (const name of PROJECTS_FAMILY) {
    const dir = join(input.home, name);
    if (have.has(dir)) push(dir);
  }
  return out;
}

/** the live half: check which family dirs exist HERE and announce the result */
export function discoverCwds(home: string = homedir()): { home: string; suggestedCwds: string[] } {
  const existing = PROJECTS_FAMILY.map((name) => join(home, name)).filter((dir) => {
    try {
      return statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
  return { home, suggestedCwds: suggestCwds({ home, existing }) };
}
