import { useEffect, useRef } from "react";
import { closeFind, cycleFindScope, findSetQuery, findStep, useFindState, type FindScope } from "@/lib/findRuntime";
import { Icon } from "@/components/ui";
import { cn } from "@/utils/cn";

/**
 * The in-app find bar (issue #194; scope picker from PR #210 review). One
 * global row under the desktop strip, rendered by Workspace while the find
 * state is open. The bar owns the keystrokes; the controller
 * (lib/findRuntime.ts) owns the query, the scope, and every panel's marks.
 *
 * Typing marks matches across the whole scope and jumps to the first;
 * Enter / Shift+Enter cycle with wrap-around (crossing panels, and
 * workspaces in the widest scope); Esc closes. The scope cycler widens the
 * search: this panel → this workspace → all workspaces.
 *
 * The browser's native find never opens — App intercepts the chord in the
 * capture phase before anything else (xterm included) sees it.
 */

const SCOPE_LABEL: Record<FindScope, string> = {
  panel: "This panel",
  space: "This workspace",
  all: "All workspaces",
};

export function FindBar() {
  const s = useFindState((x) => x);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  /* mount + every chord re-fire: focus and select the query, browser-style */
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [s.nonce]);

  /* Chrome/VS Code parity (audit B1): Esc dismisses the bar even after
     focus moves to the panel — clicking a match to read it must not strand
     the bar. The guards keep Esc's other owners: the bar's own input
     handles it directly (below), other inputs keep their own (the feed
     filter's Esc clears it), and xterm keeps it — vim in a shell is
     unusable otherwise. Enter stays INPUT-scoped on purpose: in the panel
     it edits; VS Code cycles from the widget only, same as here. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      const t = e.target as HTMLElement | null;
      if (!t || rootRef.current?.contains(t)) return;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable || t.closest(".xterm")) return;
      closeFind();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div ref={rootRef} role="search" aria-label="Find" className="shrink-0 flex items-center gap-2 px-3 h-8 border-b border-[var(--t-line)] bg-[var(--t-bg1)] t-pop">
      <Icon name="search" size={12} className="text-[var(--t-dim)] shrink-0" />
      <input
        ref={inputRef}
        value={s.query}
        onChange={(e) => findSetQuery(e.target.value)}
        onKeyDown={(e) => {
          /* an IME composition confirm is text input, never a command
             (audit B4 — the composer's own rule, ChatPanel onKeyDown) */
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter") {
            e.preventDefault();
            findStep(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            closeFind();
          }
        }}
        placeholder="Find"
        aria-label="Find text"
        className="w-56 min-w-0 bg-transparent outline-none text-[12px] text-[var(--t-fg)] placeholder:text-[var(--t-dim)]"
        style={{ caretColor: "var(--t-amber)" }}
      />
      <span className={cn("shrink-0 min-w-12 text-center text-[10.5px] tabular-nums", s.total ? "text-[var(--t-mute)]" : "text-[var(--t-dim)]")}>
        {s.query.trim() ? (s.total ? `${s.pos + 1} / ${s.total}` : "none") : ""}
      </span>
      {/* every button in the bar: mousedown preventDefault keeps keyboard
          focus in the input — a click that moved focus would turn the next
          Enter into "activate this button" (found in the round-3 smoke:
          the scope cycler appeared to ignore Enter) */}
      <button
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => findStep(-1)}
        disabled={!s.total}
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"
        className="w-6 h-6 grid place-items-center rounded text-[var(--t-mute)] hover:text-[var(--t-fg)] hover:bg-white/5 disabled:opacity-30 disabled:pointer-events-none"
      >
        <Icon name="down" size={11} className="rotate-180" />
      </button>
      <button
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => findStep(1)}
        disabled={!s.total}
        title="Next match (Enter)"
        aria-label="Next match"
        className="w-6 h-6 grid place-items-center rounded text-[var(--t-mute)] hover:text-[var(--t-fg)] hover:bg-white/5 disabled:opacity-30 disabled:pointer-events-none"
      >
        <Icon name="down" size={11} />
      </button>
      {/* the scope picker: one quiet cycler — panel → workspace → all
          (PR #210 review: every panel's text is fair game, and the choice
          stays out of the way until wanted) */}
      <button
        onMouseDown={(e) => e.preventDefault()}
        onClick={cycleFindScope}
        title="Find scope — click to widen: this panel, this workspace, all workspaces"
        aria-label={`Find scope: ${SCOPE_LABEL[s.scope]}`}
        className={cn(
          "shrink-0 h-5.5 px-2 rounded-full border text-[10px] font-mono transition-colors",
          s.scope === "panel"
            ? "border-[var(--t-line)] text-[var(--t-dim)] hover:text-[var(--t-mute)]"
            : "border-[var(--t-amber)]/50 bg-[var(--t-amber)]/10 text-[var(--t-amber)]",
        )}
      >
        {SCOPE_LABEL[s.scope]}
      </button>
      <button
        onMouseDown={(e) => e.preventDefault()}
        onClick={closeFind}
        title="Close find (Esc)"
        aria-label="Close find"
        className="w-6 h-6 grid place-items-center rounded text-[var(--t-mute)] hover:text-[var(--t-fg)] hover:bg-white/5"
      >
        <Icon name="x" size={11} />
      </button>
    </div>
  );
}
