/**
 * The directory picker's nav-state machine (issue #136). Before this, every
 * navigation re-rendered a fresh listing and the scroll container reset —
 * climbing back out of a subfolder landed at the TOP of the parent no
 * matter how far down the user had scrolled.
 *
 * The picker drives one instance for its lifetime: it reports
 * `rememberScroll(dir, scrollTop)` when navigating away from a directory
 * and applies `scrollMemory(dir)` when rendering one. File-manager rules:
 * entering a CHILD starts at 0 (fresh content reads from its top);
 * RETURNING to a visited directory — parent, sibling, the roots view —
 * restores its remembered scroll. Memory is per-path, keyed by the
 * directory's absolute path; the roots view has its own slot (null).
 *
 * Deliberately pure and defensive: no DOM, no store imports, and garbage
 * (blank dirs, negative tops, non-numbers) never throws — the picker sits
 * in a user-facing dialog and a bad value must not crash it.
 */
export interface BrowseNav {
  /** the current directory; null = the roots view */
  current(): string | null;
  /** descend into a child directory */
  enter(dir: string): void;
  /** climb via the up-button or a breadcrumb; null = back to the roots view */
  climbTo(dir: string | null): void;
  /** record how far `dir` was scrolled; call when navigating away from it */
  rememberScroll(dir: string | null, top: number): void;
  /** the remembered scroll for `dir`; 0 for a directory never visited */
  scrollMemory(dir: string | null): number;
}

export function createBrowseNav(): BrowseNav {
  let cur: string | null = null;
  const memory = new Map<string | null, number>();
  return {
    current: () => cur,
    enter(dir) {
      if (typeof dir === "string") cur = dir;
    },
    climbTo(dir) {
      if (dir === null || typeof dir === "string") cur = dir;
    },
    rememberScroll(dir, top) {
      if ((dir !== null && typeof dir !== "string") || typeof top !== "number" || !Number.isFinite(top)) return;
      memory.set(dir, Math.max(0, top));
    },
    scrollMemory(dir) {
      if (dir !== null && typeof dir !== "string") return 0;
      return memory.get(dir) ?? 0;
    },
  };
}
