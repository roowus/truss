import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
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

/** Roots with symlinks resolved (e.g. /tmp -> /private/tmp on macOS).
   Exported for the picker (audit round 2, B1): mkdir answers with the
   canonical path, so the client must be able to match a canonical path
   against a root that is itself a symlink. */
export function realBrowseRoots(): string[] {
  return realRoots();
}

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

/** A mkdir failure that already knows its HTTP status — the route maps it
   straight onto the reply instead of guessing from the message. 403 is "the
   path is outside the roots" (a permission boundary); 400 is "this is not a
   valid name or parent"; 409 is "something is already there". */
export class BrowseError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "BrowseError";
  }
}

/* Control characters (C0 + DEL) and NUL: a name the user cannot see or type
   back is never a folder the picker should create. */
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Name hygiene for the picker's "New folder" (issue #233): ONE path
   segment, or null when the caller should show why. A separator anywhere is
   malformed input (400) — never a permission problem (403) — so this stays
   a pure predicate with no filesystem access. */
export function validDirName(name: string): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 64) return null;
  if (trimmed === "." || trimmed === "..") return null;
  if (trimmed.includes("/") || trimmed.includes("\\")) return null;
  if (CONTROL.test(trimmed)) return null;
  return trimmed;
}

/** Create `name` inside `parent` — the picker's "New folder" (issue #233).
   `parent` passes the exact same confine() as listDirs, and the CONFINED
   path is what the child joins onto: the string that cleared the escape
   check and the string returned to the caller are provably the same one, so
   no later refactor can validate one path and write another. */
export function mkdirInRoots(parent: string, name: string): string {
  /* confine() is shared with listDirs, so it throws plain Errors; the route
     needs the STATUS distinction the picker's copy depends on. An escape is
     a permission answer (403); a missing parent or a file-in-the-way is bad
     input (400). Without this translation every refusal collapsed to 400
     and the documented 403 never happened. */
  const statusFor = (message: string): number =>
    /outside the browse roots|escapes the browse roots/i.test(message) ? 403 : 400;
  let parentPath: string;
  try {
    parentPath = confine(parent); // exactly like listDirs: escapes and missing dirs die here
  } catch (e: any) {
    const message = e?.message ?? String(e);
    throw new BrowseError(message, statusFor(message));
  }
  /* `parent` was a symlink: the child must be checked against where the
     write really lands, not just the lexical join. */
  let realParent: string;
  try {
    realParent = realpathSync(parentPath);
  } catch {
    throw new BrowseError(`directory does not exist: ${parentPath}`, 400);
  }
  const clean = validDirName(name);
  if (!clean) throw new BrowseError(`not a valid folder name: ${JSON.stringify(name)}`, 400);
  /* The write targets the REALPATH that was just checked, not the lexical
     parent: listDirs offers within-roots symlinks as browsable parents, and
     mkdirSync would otherwise re-resolve that link at call time — a link
     repointed outside between the check and the write would land the new
     directory outside the roots. `realParent` is verified inside the roots
     by confine(), so this is the string that actually cleared the check. */
  const target = join(realParent, clean);
  if (!within(target, realRoots())) {
    throw new BrowseError(`path is outside the browse roots: ${target}`, 403);
  }
  /* A dangling symlink at this name is invisible to statSync but mkdirSync
     would still fail on it — refuse either way, never write through it. */
  if (existsSync(target)) {
    throw new BrowseError(`already exists: ${target}`, 409);
  }
  try {
    /* NOT recursive: the syscall is the authority on the race, and a
       swallowed EEXIST would silently merge two folders into one. */
    mkdirSync(target);
  } catch (e: any) {
    const code = e?.code;
    if (code === "EEXIST") throw new BrowseError(`already exists: ${target}`, 409);
    if (code === "ENOTDIR") throw new BrowseError(`not a directory: ${target}`, 400);
    if (code === "ENOENT") throw new BrowseError(`directory does not exist: ${target}`, 400);
    throw new BrowseError(`could not create the folder: ${e?.message ?? String(e)}`, 500); // EACCES/ENOSPC/EROFS — an environment failure, not bad input
  }
  return target;
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
