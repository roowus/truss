import type { ReactNode, ButtonHTMLAttributes } from "react";
import { cn } from "@/utils/cn";
import { harnessStyle, hostOf } from "@/lib/format";
import type { SessionState } from "@/lib/proto";

/* ---------- icons (1.5px stroke, 16px grid) ---------- */
const paths: Record<string, ReactNode> = {
  plus: <path d="M8 3v10M3 8h10" />,
  x: <path d="M4 4l8 8M12 4l-8 8" />,
  chat: <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />,
  wave: <path d="M1.5 8h2l1.5-4 2 8 2-6 1.5 3 1-1h3" />,
  term: <><path d="M2 3h12v10H2z" /><path d="M4.5 6l2 2-2 2M8 10.5h3" /></>,
  gauge: <><path d="M2.5 11a5.5 5.5 0 1 1 11 0" /><path d="M8 11l2.5-3.5" /></>,
  tree: <><path d="M4 2.5v11M4 6h4M4 11h4" /><circle cx="10" cy="6" r="1.6" /><circle cx="10" cy="11" r="1.6" /></>,
  spark: <path d="M8 1.5l1.6 4.9 4.9 1.6-4.9 1.6L8 14.5l-1.6-4.9L1.5 8l4.9-1.6z" />,
  stop: <rect x="4" y="4" width="8" height="8" rx="1" />,
  send: <path d="M2.5 8h9M8 4l4 4-4 4" />,
  trash: <path d="M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.7 9h5.6l.7-9" />,
  power: <><path d="M8 2v6" /><path d="M4.6 4.2a5 5 0 1 0 6.8 0" /></>,
  chev: <path d="M6 4l4 4-4 4" />,
  down: <path d="M4 6l4 4 4-4" />,
  folder: <path d="M2 4h4l1.5 1.5H14V12H2z" />,
  tag: <><path d="M2 2h4.5l5.5 5.5a1 1 0 0 1 0 1.4l-3.1 3.1a1 1 0 0 1-1.4 0L2 6.5z" /><circle cx="4.8" cy="4.8" r="0.9" /></>,
  lock: <><rect x="3" y="7" width="10" height="7" rx="1" /><path d="M5 7V5a3 3 0 0 1 6 0v2" /></>,
  check: <path d="M3 8.5l3 3 7-7" />,
  alert: <><path d="M8 2l6.5 11.5h-13z" /><path d="M8 6.5v3M8 11.5v.5" /></>,
  retry: <><path d="M13 8a5 5 0 1 1-1.5-3.5" /><path d="M13 2.5v3h-3" /></>,
  layout: <><rect x="2" y="2.5" width="12" height="11" /><path d="M7 2.5v11M7 8h7" /></>,
  search: <><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></>,
  bolt: <path d="M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z" />,
  host: <><rect x="2" y="3" width="12" height="4" rx=".5" /><rect x="2" y="9" width="12" height="4" rx=".5" /><path d="M4.5 5h.01M4.5 11h.01" /></>,
  brain: <path d="M6 3a2 2 0 0 0-2 2 2 2 0 0 0-1.5 3A2 2 0 0 0 4 11a2 2 0 0 0 2 2h0V3zM10 3a2 2 0 0 1 2 2 2 2 0 0 1 1.5 3A2 2 0 0 1 12 11a2 2 0 0 1-2 2V3z" />,
  restart: <><path d="M3 8a5 5 0 0 1 8.5-3.5L13 6" /><path d="M13 2.5V6H9.5" /><path d="M13 8a5 5 0 0 1-8.5 3.5L3 10" /></>,
  dots: <g fill="currentColor" stroke="none"><circle cx="3.2" cy="8" r="1.2" /><circle cx="8" cy="8" r="1.2" /><circle cx="12.8" cy="8" r="1.2" /></g>,
  settings: <><circle cx="8" cy="8" r="2.3" /><path d="M6.6 1.7h2.8l.4 1.5 1.2.7 1.5-.3 1.4 2.4-1.1 1.1v1.4l1.1 1.1-1.4 2.4-1.5-.3-1.2.7-.4 1.5H6.6l-.4-1.5-1.2-.7-1.5.3-1.4-2.4 1.1-1.1V7.1L2.1 6l1.4-2.4 1.5.3 1.2-.7z" /></>,
  desktop: <><rect x="1.5" y="2" width="10" height="8" rx="1" /><path d="M4 12h10V5.5M6.5 12v2M4 14h6" /></>,
  copy: <><rect x="5" y="5" width="9" height="9" rx="1" /><path d="M11 5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h2" /></>,
  edit: <><path d="M3 11.5V13h1.5l8-8-1.5-1.5-8 8zM10.5 4l1.5-1.5 1.5 1.5L12 5.5" /></>,
  arrow: <path d="M2.5 8h10M8.5 4l4 4-4 4" />,
};
export function Icon({ name, size = 14, className }: { name: keyof typeof paths | string; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className={cn("shrink-0", className)} aria-hidden>
      {paths[name]}
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
  return (
    <span
      className={cn("relative inline-grid place-items-center rounded-[5px] font-mono font-semibold leading-none shrink-0", className)}
      style={{ width: size, height: size, fontSize: size * 0.58, color: h.color, background: `color-mix(in oklab, ${h.color} 14%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${h.color} 35%, transparent)` }}
      title={harness}
    >
      {h.glyph}
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
