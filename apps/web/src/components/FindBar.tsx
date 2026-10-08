import { useEffect, useRef, useState } from "react";
import type { FindProvider } from "@/lib/findRuntime";
import { Icon } from "@/components/ui";
import { cn } from "@/utils/cn";

/**
 * The in-app find bar (issue #194): one of these per searchable panel,
 * rendered as an overlay at the panel's top-right corner while that panel
 * is the find target (Cmd/Ctrl+F — App.tsx picks the focused panel).
 *
 * The bar owns the keystrokes, the provider (lib/findRuntime.ts) owns the
 * marks: typing paints every match and jumps to the first, Enter /
 * Shift+Enter cycle with wrap-around, Esc closes and hands focus back to
 * the panel. The browser's native find never opens — App intercepts the
 * chord before anything else sees it.
 */
export function FindBar({ provider, nonce, onClose }: { provider: FindProvider; nonce: number; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [count, setCount] = useState(0);
  const [idx, setIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  /* re-firing Cmd/Ctrl+F with the bar already open re-selects the query,
     browser-style (the nonce bump is the signal) */
  useEffect(() => {
    if (nonce > 0) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [nonce]);
  /* a live panel (streaming chat, polling monitor) repaints under the open
     bar and pushes the fresh count here */
  useEffect(() => {
    provider.onRecount = (n) => {
      setCount(n);
      setIdx((i) => (n ? Math.min(Math.max(i, 0), n - 1) : -1));
    };
    return () => {
      provider.onRecount = undefined;
    };
  }, [provider]);
  /* marks die with the bar: close, re-target, or the panel unmounting */
  useEffect(
    () => () => {
      provider.clear();
      provider.focus?.();
    },
    [provider],
  );

  const apply = (value: string) => {
    setQ(value);
    const n = provider.setQuery(value);
    setCount(n);
    setIdx(n ? 0 : -1);
  };
  const step = (dir: 1 | -1) => setIdx(provider.step(dir));

  return (
    <div role="search" aria-label="Find in this panel" className="absolute top-2 right-3 z-20 flex items-center gap-1 h-7 pl-2 pr-1 rounded-md bg-[var(--t-bg2)] border border-[var(--t-line2)] shadow-xl t-pop">
      <Icon name="search" size={11} className="text-[var(--t-dim)] shrink-0" />
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => apply(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        placeholder="Find in panel"
        aria-label="Find in this panel"
        /* Cmd/Ctrl held while typing would re-fire the chord via App's
           capture listener — the input itself needs no guard */
        className="w-44 bg-transparent outline-none text-[12px] text-[var(--t-fg)] placeholder:text-[var(--t-dim)]"
        style={{ caretColor: "var(--t-amber)" }}
      />
      <span className={cn("shrink-0 min-w-11 text-center text-[10px] tabular-nums", count ? "text-[var(--t-mute)]" : "text-[var(--t-dim)]")}>
        {q.trim() ? (count ? `${idx + 1} / ${count}` : "none") : ""}
      </span>
      <button
        onClick={() => step(-1)}
        disabled={!count}
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"
        className="w-5.5 h-5.5 grid place-items-center rounded text-[var(--t-mute)] hover:text-[var(--t-fg)] hover:bg-white/5 disabled:opacity-30 disabled:pointer-events-none"
      >
        <Icon name="down" size={11} className="rotate-180" />
      </button>
      <button
        onClick={() => step(1)}
        disabled={!count}
        title="Next match (Enter)"
        aria-label="Next match"
        className="w-5.5 h-5.5 grid place-items-center rounded text-[var(--t-mute)] hover:text-[var(--t-fg)] hover:bg-white/5 disabled:opacity-30 disabled:pointer-events-none"
      >
        <Icon name="down" size={11} />
      </button>
      <button
        onClick={onClose}
        title="Close find (Esc)"
        aria-label="Close find"
        className="w-5.5 h-5.5 grid place-items-center rounded text-[var(--t-mute)] hover:text-[var(--t-fg)] hover:bg-white/5"
      >
        <Icon name="x" size={11} />
      </button>
    </div>
  );
}
