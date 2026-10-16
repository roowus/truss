import { useCallback, useEffect, useRef, useState } from "react";
import { isNavKey, isOpenKey, nextIndex, typeaheadIndex } from "./listKeys";


/* ---- the hook's decisions, as pure functions -------------------------

   These are what the hook actually calls, so the menu's key handling is
   covered by real tests rather than only by source greps: the same remedy
   the Files tree got with shouldTakeTreeFocus. */

/** What a key on a CLOSED menu trigger means. */
export type TriggerIntent = "open" | "close" | "ignore";

export function triggerIntent(key: string, open: boolean): TriggerIntent {
  if (open) return key === "Escape" ? "close" : "ignore";
  return isOpenKey(key) ? "open" : "ignore";
}

/** What a key inside an OPEN menu means. */
export type MenuKeyIntent =
  | { kind: "close" }
  | { kind: "activate" }
  | { kind: "move"; wrap: true }
  | { kind: "typeahead" }
  | { kind: "ignore" };

/** `count` is only needed to stay honest about disabled/empty menus. */
export function menuKeyIntent(e: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }): MenuKeyIntent {
  if (e.key === "Escape") return { kind: "close" };
  if (e.key === "Enter" || e.key === " ") return { kind: "activate" };
  if (isNavKey(e.key)) return { kind: "move", wrap: true };
  if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) return { kind: "typeahead" };
  return { kind: "ignore" };
}

/** Fold a printable character into the typeahead buffer, resetting it when
 *  the user pauses — so "ar" reaches "Archive workspace" but a later "d"
 *  starts a fresh search. */
export function typeaheadBuffer(prev: string, prevAt: number, key: string, now: number, gapMs = 700): string {
  return now - prevAt > gapMs ? key : prev + key;
}

/**
 * Roving focus for the app's own popup menus (issue #227).
 *
 * The two hand-rolled menus (the workspace ⋯ menu, the running-agents
 * menu) had no key handling at all. This hook owns the index and turns
 * key events into movements through `listKeys`, so the menus share one
 * implementation instead of two near-copies.
 *
 * Semantics (agreed design): the trigger is a real button in the tab
 * order; Enter/Space/Down opens the menu and focuses the first item;
 * Up/Down/Home/End move and wrap; Enter activates; Esc closes and hands
 * focus back to the trigger; printable characters jump to the next item
 * whose label starts with what has been typed.
 *
 * Disabled items are still reachable on purpose: an aria-disabled row
 * stays focusable so the menu can explain why an action is unavailable,
 * and activating one is a no-op.
 */
export interface MenuCursor {
  /** Index of the highlighted row, or -1 when nothing is highlighted. */
  index: number;
  setIndex: (i: number) => void;
  /** Reset to the first row when the menu opens. */
  reset: () => void;
  /** Handler for the trigger button. */
  onTriggerKeyDown: (e: React.KeyboardEvent) => void;
  /** Handler for the menu container (or any row inside it). */
  onMenuKeyDown: (e: React.KeyboardEvent, activate: (i: number) => void) => void;
}

export function useMenuCursor(
  count: number,
  opts: { open: boolean; onOpen: () => void; onClose: () => void; labels: string[]; trigger?: () => HTMLElement | null },
): MenuCursor {
  const [index, setIndex] = useState(-1);
  /* the typeahead buffer: printable keys accumulate for a beat so "ar"
     can reach "Archive workspace", then reset */
  const typed = useRef("");
  const typedAt = useRef(0);

  useEffect(() => {
    if (!opts.open) {
      setIndex(-1);
      typed.current = "";
    }
  }, [opts.open]);

  const reset = useCallback(() => {
    setIndex(count > 0 ? 0 : -1);
    typed.current = "";
  }, [count]);

  const close = useCallback(() => {
    opts.onClose();
    /* focus must land back on the trigger, not on <body>, or the next Tab
       starts from the top of the document */
    opts.trigger?.()?.focus();
  }, [opts]);

  const onTriggerKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const intent = triggerIntent(e.key, opts.open);
      if (intent === "ignore") return;
      e.preventDefault();
      if (intent === "close") {
        e.stopPropagation();
        close();
      } else {
        opts.onOpen();
      }
    },
    [opts, close],
  );

  const onMenuKeyDown = useCallback(
    (e: React.KeyboardEvent, activate: (i: number) => void) => {
      const intent = menuKeyIntent(e);
      if (intent.kind === "ignore") return;
      e.preventDefault();
      switch (intent.kind) {
        case "close":
          e.stopPropagation();
          close();
          return;
        case "activate":
          if (index >= 0) activate(index);
          return;
        case "move":
          /* menus wrap — arrowing off the end comes back to the start */
          setIndex((i) => nextIndex(i, count, e.key, { wrap: intent.wrap }));
          return;
        case "typeahead": {
          const now = Date.now();
          typed.current = typeaheadBuffer(typed.current, typedAt.current, e.key, now);
          typedAt.current = now;
          const hit = typeaheadIndex(opts.labels, typed.current, index);
          if (hit >= 0) setIndex(hit);
          return;
        }
      }
    },
    [index, count, opts.labels, close],
  );

  return { index, setIndex, reset, onTriggerKeyDown, onMenuKeyDown };
}
