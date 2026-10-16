import { nextIndex } from "./listKeys";

/**
 * The Files tree's keyboard behavior, as pure functions (issue #227).
 *
 * The tree's rows are a flat array in *visible* order — expanded folders
 * inlined, collapsed subtrees absent — so navigation is index math over
 * that array plus a couple of tree idioms. Keeping it here (rather than
 * inline in the panel) means the rules are testable without a DOM, and
 * #226 can reuse the same visible order for shift-ranges.
 */

export interface TreeRow {
  path: string;
  kind: "file" | "dir";
}

/** What a key press does to the tree, as data the panel applies. */
export type TreeAction =
  | { type: "move"; index: number }
  | { type: "open"; path: string }
  | { type: "expand"; path: string }
  | { type: "collapse"; path: string }
  | { type: "none" };

/**
 * Resolve a key against the visible rows. `cursor` may be -1 (nothing
 * focused). Left/Right act on a focused *folder* only: Right expands an
 * unexpanded folder, Left collapses an expanded one, and both are no-ops
 * on files (a tree never collapses into a file). Enter opens: a folder
 * toggles, a file is selected for preview.
 */
export function treeKey(cursor: number, rows: TreeRow[], expanded: Record<string, boolean>, key: string): TreeAction {
  if (rows.length === 0) return { type: "none" };
  const at = cursor >= 0 && cursor < rows.length ? rows[cursor] : undefined;

  if (key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End") {
    /* Up/Down clamp (a tree is a list, not a menu); Home/End jump to the
       ends; nothing-focused enters at the top going down, the bottom up */
    return { type: "move", index: nextIndex(cursor, rows.length, key) };
  }

  if (key === "Enter") {
    if (!at) return { type: "none" };
    return at.kind === "dir" ? { type: "expand", path: at.path } : { type: "open", path: at.path };
  }

  if (key === "ArrowRight") {
    if (!at || at.kind !== "dir") return { type: "none" };
    return expanded[at.path] ? { type: "none" } : { type: "expand", path: at.path };
  }

  if (key === "ArrowLeft") {
    if (!at || at.kind !== "dir") return { type: "none" };
    return expanded[at.path] ? { type: "collapse", path: at.path } : { type: "none" };
  }

  return { type: "none" };
}

/**
 * Keep a cursor valid across list changes (a folder collapsed, a search
 * replaced the rows, a reload emptied the tree). Returns the nearest
 * sensible index rather than leaving the cursor pointing at nothing.
 */
export function clampCursor(cursor: number, count: number): number {
  if (count <= 0) return -1;
  if (cursor < 0) return -1;
  return Math.min(cursor, count - 1);
}

/**
 * May the Files tree take focus right now? (issue #227)
 *
 * The tree focuses itself when the panel mounts, because a dockview panel
 * has no focusable parent and the arrows must work without a preliminary
 * click. It must never steal focus, though: a dialog, the tab picker's
 * search box, or an inline rename all legitimately own the caret, and
 * yanking it mid-typing is worse than making the user click once.
 *
 * The rule: take focus only when the caret is parked on nothing in
 * particular (the body or the document element). Anything else wins.
 * Pure, so the decision is testable without a DOM.
 */
export function shouldTakeTreeFocus(opts: {
  connected: boolean;
  /** the active element is the tree itself or a descendant of it */
  containsActive: boolean;
  /** the active element's tag name, or null when there is none */
  activeTag: string | null;
}): boolean {
  if (!opts.connected) return false;
  if (opts.containsActive) return false;
  const tag = (opts.activeTag ?? "").toUpperCase();
  return tag === "" || tag === "BODY" || tag === "HTML";
}
