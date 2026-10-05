import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type ButtonHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/utils/cn";
import { harnessStyle, hostOf } from "@/lib/format";
import { clampPopoverPos } from "@/lib/popover";
import { selectTriggerHeight } from "@/lib/controls";
import { HarnessLogo } from "./harnessLogos";
import { ICON_PATHS } from "@/lib/icons";
import type { SessionState } from "@/lib/proto";

/* the glyph registry lives in @/lib/icons (issue #99); filled entries
   (fill: true, e.g. pinSolid) render fill="currentColor" with no stroke,
   everything else strokes as before */
export function Icon({ name, size = 14, className }: { name: keyof typeof ICON_PATHS | string; size?: number; className?: string }) {
  const def = ICON_PATHS[name];
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill={def?.fill ? "currentColor" : "none"} stroke={def?.fill ? "none" : "currentColor"} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className={cn("shrink-0", className)} aria-hidden>
      {def && <path d={def.path} />}
    </svg>
  );
}

/* ---------- brand ---------- */
export function TrussLogo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size * 1.6} height={size} viewBox="0 0 32 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round" aria-label="Truss">
      <path d="M1 18h30M3 3h26" />
      <path d="M1 18L6 3l5 15 5-15 5 15 5-15 5 15" />
    </svg>
  );
}

/* ---------- harness identity ---------- */
export function HarnessMark({ harness, size = 20, className }: { harness: string; size?: number; className?: string }) {
  const h = harnessStyle(harness);
  const host = hostOf(harness);
  const logo = <HarnessLogo harness={harness} size={size} />;
  return (
    <span
      className={cn("relative inline-grid place-items-center rounded-[5px] font-mono font-semibold leading-none shrink-0 overflow-hidden", className)}
      style={logo ? { width: size, height: size, boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${h.color} 35%, transparent)` } : { width: size, height: size, fontSize: size * 0.58, color: h.color, background: `color-mix(in oklab, ${h.color} 14%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${h.color} 35%, transparent)` }}
      title={harness}
    >
      {logo ?? h.glyph}
      {host && <span className="absolute -right-1 -bottom-1 w-2 h-2 rounded-full bg-[var(--t-sky)] ring-2 ring-[var(--t-bg1)]" title={`remote: ${host}`} />}
    </span>
  );
}

/* ---------- session state ---------- */
export const STATE_META: Record<SessionState, { label: string; color: string; hint: string }> = {
  spawning: { label: "spawning", color: "var(--t-amber)", hint: "harness process is booting" },
  idle: { label: "idle", color: "var(--t-teal)", hint: "alive, waiting for a prompt" },
  running: { label: "running", color: "var(--t-amber)", hint: "a turn is in progress" },
  error: { label: "error", color: "var(--t-red)", hint: "the harness crashed — prompting will try to resume it" },
  closed: { label: "closed", color: "var(--t-dim)", hint: "process not running — prompting resumes it with history" },
};

export function StateDot({ state, size = 8 }: { state: SessionState; size?: number }) {
  const m = STATE_META[state] ?? STATE_META.closed;
  if (state === "running")
    return (
      <span className="inline-flex items-end gap-[2px] shrink-0" style={{ height: size + 2 }} title={m.hint}>
        {[0, 1, 2].map((i) => (
          <span key={i} className="w-[2px] rounded-sm t-eq" style={{ background: m.color, height: size + 2, animationDelay: `${i * 0.15}s` }} />
        ))}
      </span>
    );
  return (
    <span
      className={cn("inline-block rounded-full shrink-0", state === "spawning" && "t-pulse")}
      title={m.hint}
      style={{
        width: size,
        height: size,
        background: state === "closed" ? "transparent" : m.color,
        boxShadow: state === "closed" ? `inset 0 0 0 1.5px ${m.color}` : state === "idle" ? `0 0 0 3px color-mix(in oklab, ${m.color} 18%, transparent)` : undefined,
      }}
    />
  );
}

export function StatePill({ state, detail }: { state: SessionState; detail?: string }) {
  const m = STATE_META[state] ?? STATE_META.closed;
  return (
    <span className="inline-flex items-center gap-1.5 h-5 px-2 rounded-full font-mono text-[10.5px] uppercase tracking-wider" style={{ color: m.color, background: `color-mix(in oklab, ${m.color} 12%, transparent)` }} title={detail ? `${m.hint} — ${detail}` : m.hint}>
      <StateDot state={state} size={6} />
      {m.label}
    </span>
  );
}

/* ---------- buttons ---------- */
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "ghost" | "solid" | "outline" | "danger" | "amber"; size?: "xs" | "sm" | "md"; icon?: string };
export function Btn({ variant = "ghost", size = "sm", icon, className, children, ...rest }: BtnProps) {
  return (
    <button
      {...rest}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors select-none disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-[var(--t-amber)] focus-visible:outline-offset-1",
        size === "xs" && "h-6 px-1.5 text-[11px]",
        size === "sm" && "h-7 px-2.5 text-[12px]",
        size === "md" && "h-9 px-3.5 text-[13px]",
        variant === "ghost" && "text-[var(--t-mute)] hover:text-[var(--t-fg)] hover:bg-white/[0.05]",
        variant === "outline" && "text-[var(--t-fg)] border border-[var(--t-line2)] hover:border-[var(--t-mute)] hover:bg-white/[0.03]",
        variant === "solid" && "bg-[var(--t-fg)] text-[var(--t-bg0)] hover:bg-white",
        variant === "amber" && "bg-[var(--t-amber)] text-[#1b1305] hover:brightness-110",
        variant === "danger" && "text-[var(--t-red)] border border-[color-mix(in_oklab,var(--t-red)_40%,transparent)] hover:bg-[color-mix(in_oklab,var(--t-red)_12%,transparent)]",
        className,
      )}
    >
      {icon && <Icon name={icon} size={size === "md" ? 15 : 13} />}
      {children}
    </button>
  );
}

export function IconBtn({ icon, label, className, active, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: string; label: string; active?: boolean }) {
  return (
    <button
      {...rest}
      title={label}
      aria-label={label}
      className={cn(
        "inline-grid place-items-center w-7 h-7 rounded-md text-[var(--t-mute)] hover:text-[var(--t-fg)] hover:bg-white/[0.06] transition-colors disabled:opacity-30",
        active && "text-[var(--t-amber)] bg-[color-mix(in_oklab,var(--t-amber)_12%,transparent)]",
        className,
      )}
    >
      <Icon name={icon} />
    </button>
  );
}

export const Kbd = ({ children }: { children: ReactNode }) => (
  <kbd className="inline-grid place-items-center min-w-[18px] h-[18px] px-1 rounded border border-[var(--t-line2)] bg-[var(--t-bg2)] font-mono text-[10px] text-[var(--t-mute)]">{children}</kbd>
);

export function Empty({ icon, title, children }: { icon: string; title: string; children?: ReactNode }) {
  return (
    <div className="h-full grid place-items-center p-6">
      <div className="max-w-[300px] text-center">
        <div className="mx-auto mb-3 w-10 h-10 grid place-items-center rounded-lg border border-dashed border-[var(--t-line2)] text-[var(--t-dim)]">
          <Icon name={icon} size={18} />
        </div>
        <div className="text-[13px] text-[var(--t-fg)] font-medium">{title}</div>
        {children && <div className="mt-1.5 text-[12px] leading-relaxed text-[var(--t-mute)]">{children}</div>}
      </div>
    </div>
  );
}

export function Spinner({ size = 12, color = "var(--t-amber)" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className="t-spin shrink-0" aria-hidden>
      <circle cx="8" cy="8" r="6" fill="none" stroke={color} strokeOpacity=".25" strokeWidth="2" />
      <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/* ---------- custom select (no native dropdowns) ---------- */
export interface SelectOption {
  value: string;
  label: ReactNode;
  hint?: string;
}

/** A dropdown that matches the app: portal list, typeahead, arrows+enter+esc, click-outside. */
export function Select({
  value,
  options,
  onChange,
  className,
  disabled,
  ariaLabel,
  width,
  size = "form",
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
  width?: number | string;
  /** "bar" = the compact 24px filter-bar row (matches the search box);
     "form" (default) = 34px t-input — every dialog keeps its look */
  size?: "bar" | "form";
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [filter, setFilter] = useState("");
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const current = options.find((o) => o.value === value);

  const textOf = (o: SelectOption) =>
    `${typeof o.label === "string" ? o.label : ""} ${o.hint ?? ""} ${o.value}`.toLowerCase();
  const visible = filter
    ? options.filter((o) => filter.toLowerCase().split(/\s+/).every((w) => textOf(o).includes(w)))
    : options;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!btnRef.current?.contains(e.target as Node) && !listRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);

  useEffect(() => {
    if (open) listRef.current?.querySelector<HTMLElement>("[data-hl]")?.scrollIntoView({ block: "nearest" });
  }, [open, highlight]);

  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
    btnRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(e.key)) {
        e.preventDefault();
        setHighlight(Math.max(0, options.findIndex((o) => o.value === value)));
        setOpen(true);
      }
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); btnRef.current?.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => Math.min(visible.length - 1, h + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => Math.max(0, h - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); const o = visible[highlight]; if (o) pick(o.value); }
    else if (e.key.length === 1 && /\S/.test(e.key)) {
      /* type to filter — preventDefault keeps the char from also landing
         in the search input after focus moves (the double-capture bug) */
      e.preventDefault();
      setFilter((f) => f + e.key);
      setHighlight(0);
      filterRef.current?.focus();
    } else if (e.key === "Backspace" && filter) {
      setFilter((f) => f.slice(0, -1));
      setHighlight(0);
    }
  };

  const onFilterKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => Math.min(visible.length - 1, h + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => Math.max(0, h - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); const o = visible[highlight]; if (o) pick(o.value); }
    else if (e.key === "Escape") { e.preventDefault(); setOpen(false); btnRef.current?.focus(); }
  };

  /* measure the actual popover and clamp it inside the viewport — a
     left-anchored dropdown near the right edge used to run off-screen */
  const [popPos, setPopPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const b = btnRef.current?.getBoundingClientRect();
    const pop = listRef.current;
    if (!b || !pop) return;
    setPopPos(clampPopoverPos(b, pop.offsetWidth, pop.offsetHeight, window.innerWidth, window.innerHeight));
  }, [open, filter, options.length]);

  const rect = btnRef.current?.getBoundingClientRect();
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (!open) {
            setFilter("");
            setHighlight(Math.max(0, options.findIndex((o) => o.value === value)));
          }
          setOpen((v) => !v);
        }}
        onKeyDown={onKeyDown}
        className={cn(
          "t-input inline-flex items-center justify-between gap-2 text-left select-none cursor-pointer",
          "focus-visible:outline-2 focus-visible:outline-[var(--t-amber)] focus-visible:outline-offset-1",
          disabled && "opacity-40 cursor-not-allowed",
          className,
        )}
        style={{ ...(width ? { width } : {}), height: selectTriggerHeight(size) }}
      >
        <span className="min-w-0 truncate">{current ? current.label : <span className="text-[var(--t-dim)]">—</span>}</span>
        <Icon name="down" size={11} className={cn("shrink-0 text-[var(--t-dim)] transition-transform", open && "rotate-180")} />
      </button>
      {open && rect && createPortal(
        <div
          ref={listRef}
          role="listbox"
          aria-label={ariaLabel}
          className="fixed z-[170] max-h-[280px] overflow-auto t-scroll rounded-lg bg-[var(--t-bg2)] border border-[var(--t-line2)] shadow-2xl pb-1 t-pop"
          style={
            popPos
              ? { top: popPos.top, left: popPos.left, minWidth: rect.width, maxWidth: Math.min(440, window.innerWidth - 16) }
              : { top: -9999, left: -9999, minWidth: rect.width } /* off-screen until measured — no flash of a clipped popover */
          }
        >
          {/* flush to the popover's top edge: an opaque cover so scrolled
              options never peek above it (the old py-1 left a 4px gap) */}
          <div className="sticky top-0 z-10 flex items-center gap-2 px-3 h-8 bg-[var(--t-bg2)] rounded-t-lg border-b border-[var(--t-line)]">
            <Icon name="search" size={11} className="text-[var(--t-dim)]" />
            <input
              ref={filterRef}
              value={filter}
              onChange={(e) => { setFilter(e.target.value); setHighlight(0); }}
              onKeyDown={onFilterKeyDown}
              placeholder={`filter ${options.length}…`}
              aria-label="Filter options"
              className="flex-1 min-w-0 bg-transparent text-[11.5px] outline-none text-[var(--t-fg)] placeholder:text-[var(--t-dim)]"
            />
            {filter && <span className="text-[9.5px] font-mono text-[var(--t-dim)]">{visible.length}</span>}
          </div>
          {visible.map((o, i) => (
            <div
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              data-hl={i === highlight ? "" : undefined}
              onPointerEnter={() => setHighlight(i)}
              onClick={() => pick(o.value)}
              className={cn(
                "flex items-center gap-2 px-3 h-8 cursor-pointer text-[12px]",
                i === highlight ? "bg-white/[0.06] text-[var(--t-fg)]" : "text-[var(--t-fg2)]",
                o.value === value && "text-[var(--t-amber)]",
              )}
            >
              <span className="w-3 shrink-0">{o.value === value && <Icon name="check" size={11} />}</span>
              <span className="min-w-0 truncate flex-1">{o.label}</span>
              {o.hint && <span className="shrink-0 text-[10px] text-[var(--t-dim)]">{o.hint}</span>}
            </div>
          ))}
          {visible.length === 0 && (
            <div className="px-3 py-4 text-center text-[11px] text-[var(--t-dim)]">No matches for “{filter}”.</div>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
