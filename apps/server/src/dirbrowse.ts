import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

/**
 * Directory browsing for the New Session dialog's cwd picker (issue #106).
 * Directory NAMES only — never file contents — and every listing is
 * confined to browseRoots(): a path outside the roots is refused whether it
 * escapes lexically (../..) or through a symlink whose target leaves the
 * roots. Same spirit as the files.ts workspace confine.
 *
 * Errors are plain "not a directory" / "does not exist" / "outside the
 * roots" messages — the route returns them as-is, so no stacks and no
 * partial data.
 */

export interface BrowseDir {
  name: string;
  path: string; // absolute
}

export interface DirListing {
  dirs: BrowseDir[];
  parent: string | null; // browsable parent for the up-button; null at a root
}

/** Where the picker may start: the user's home first, only real dirs. */
export function browseRoots(): string[] {
  const out: string[] = [];
  for (const candidate of [homedir(), tmpdir()]) {
    if (!candidate || out.includes(candidate)) continue;
    try {
      if (statSync(candidate).isDirectory()) out.push(candidate);
    } catch {
      /* not a real dir on this box — skip */
    }
  }
  return out;
}

/** Roots with symlinks resolved (e.g. /tmp -> /private/tmp on macOS). */
function realRoots(): string[] {
  const out: string[] = [];
  for (const root of browseRoots()) {
    try {
      const real = realpathSync(root);
      if (!out.includes(real)) out.push(real);
    } catch {
      /* unreachable root — skip */
    }
  }
  return out;
}

const within = (p: string, roots: string[]): boolean => roots.some((r) => p === r || p.startsWith(r + sep));

/** Resolve the input and prove it stays inside the roots; returns the
   lexical absolute path to list (children join onto it). */
function confine(input: string): string {
  if (!input || typeof input !== "string") throw new Error("missing path");
  const expanded = input === "~" || input.startsWith(`~${sep}`) || input.startsWith("~/") ? join(homedir(), input.slice(1)) : input;
  const p = resolve(expanded);
  const roots = browseRoots();
  if (!within(p, roots) && !within(p, realRoots())) {
    throw new Error(`path is outside the browse roots: ${p}`);
  }
  let real: string;
  try {
    real = realpathSync(p);
  } catch {
    throw new Error(`directory does not exist: ${p}`);
  }
  if (!within(real, realRoots())) {
    throw new Error(`path escapes the browse roots through a symlink: ${p}`);
  }
  if (!statSync(real).isDirectory()) {
    throw new Error(`not a directory: ${p}`);
  }
  return p;
}

export function listDirs(absPath: string, opts?: { showHidden?: boolean }): DirListing {
  const dir = confine(absPath);
  const dirs: BrowseDir[] = [];
  let rroots: string[] | null = null; // resolved lazily, only when a symlinked dir shows up
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "." || entry.name === "..") continue;
    if (!opts?.showHidden && entry.name.startsWith(".")) continue;
    const abs = join(dir, entry.name);
    let isDir = entry.isDirectory();
    if (!isDir && entry.isSymbolicLink()) {
      /* a link to a dir follows (browsing into it is still confined on the
         next call); a broken link is skipped, and a link whose target
         leaves the roots is not offered at all — it would only 400 on
         click */
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        rroots ??= realRoots();
        try {
          if (!within(realpathSync(abs), rroots)) continue;
        } catch {
          continue;
        }
      }
    }
    if (!isDir) continue;
    dirs.push({ name: entry.name, path: abs });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  const up = dirname(dir);
  const parent = up !== dir && (within(up, browseRoots()) || within(up, realRoots())) ? up : null;
  return { dirs, parent };
}
