/** Inline SVG sprite — Lucide-style strokes, ported from the v11 mockup. */

export type IconName =
  | "plus"
  | "x"
  | "chev-d"
  | "chev-r"
  | "msg"
  | "term"
  | "pulse"
  | "agents"
  | "ctx"
  | "brain"
  | "zap"
  | "check"
  | "checklist"
  | "git"
  | "send"
  | "fork"
  | "split"
  | "filter"
  | "export"
  | "dot"
  | "halfdot"
  | "clock"
  | "paperclip"
  | "model"
  | "shield"
  | "folder"
  | "target";

export type LogoName = "claude" | "deepseek" | "pi" | "hermes";

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg className={className ?? "ic"}>
      <use href={`#i-${name}`} />
    </svg>
  );
}

export function HarnessLogo({ harness, name }: { harness: string; name?: string }) {
  const map: Record<string, [string, LogoName]> = {
    "claude-code": ["cc", "claude"],
    dsh: ["dsh", "deepseek"],
    pi: ["pi", "pi"],
    hermes: ["her", "hermes"],
  };
  const entry = map[harness];
  if (!entry) {
    return (
      <span className="hlogo none" data-name={name ?? harness}>
        <Icon name="dot" className="ic" />
      </span>
    );
  }
  return (
    <span className={`hlogo ${entry[0]}`} data-name={name ?? harness}>
      <svg>
        <use href={`#lg-${entry[1]}`} />
      </svg>
    </span>
  );
}

export function Sprite() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }}>
      <defs>
        <symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></symbol>
        <symbol id="i-x" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12" /></symbol>
        <symbol id="i-chev-d" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" /></symbol>
        <symbol id="i-chev-r" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6" /></symbol>
        <symbol id="i-msg" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></symbol>
        <symbol id="i-term" viewBox="0 0 24 24"><path d="m4 17 6-6-6-6M12 19h8" /></symbol>
        <symbol id="i-pulse" viewBox="0 0 24 24"><path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 0-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" /></symbol>
        <symbol id="i-agents" viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></symbol>
        <symbol id="i-ctx" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 21V9" /></symbol>
        <symbol id="i-brain" viewBox="0 0 24 24"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" /><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" /><path d="M12 5v13" /></symbol>
        <symbol id="i-zap" viewBox="0 0 24 24"><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" /></symbol>
        <symbol id="i-check" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5" /></symbol>
        <symbol id="i-checklist" viewBox="0 0 24 24"><path d="m3 17 2 2 4-4M3 7l2 2 4-4M13 6h8M13 12h8M13 18h8" /></symbol>
        <symbol id="i-git" viewBox="0 0 24 24"><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="6" r="3" /><path d="M6 9v9M18 9a9 9 0 0 1-9 9" /></symbol>
        <symbol id="i-send" viewBox="0 0 24 24"><path d="M14.5 21.7a.5.5 0 0 0 .94-.02l6.5-19a.5.5 0 0 0-.63-.63l-19 6.5a.5.5 0 0 0-.02.94l7.93 3.18a2 2 0 0 1 1.11 1.11z" /><path d="m21.85 2.15-10.94 10.94" /></symbol>
        <symbol id="i-fork" viewBox="0 0 24 24"><circle cx="12" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><circle cx="18" cy="6" r="3" /><path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9M12 12v3" /></symbol>
        <symbol id="i-split" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M12 3v18" /></symbol>
        <symbol id="i-filter" viewBox="0 0 24 24"><path d="M22 3H2l8 9.46V19l4 2v-8.54z" /></symbol>
        <symbol id="i-export" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" /></symbol>
        <symbol id="i-dot" viewBox="0 0 24 24"><circle cx="12" cy="12" r="5" /></symbol>
        <symbol id="i-halfdot" viewBox="0 0 24 24"><circle cx="12" cy="12" r="6" /><path d="M12 6a6 6 0 0 1 0 12z" fill="currentColor" stroke="none" /></symbol>
        <symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></symbol>
        <symbol id="i-paperclip" viewBox="0 0 24 24"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 0 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" /></symbol>
        <symbol id="i-model" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" /><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" /></symbol>
        <symbol id="i-shield" viewBox="0 0 24 24"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /></symbol>
        <symbol id="i-folder" viewBox="0 0 24 24"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></symbol>
        <symbol id="i-target" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" /></symbol>
        <symbol id="lg-claude" viewBox="0 0 24 24"><path fill="#d97757" d="M12 2c.7 2.9 2.4 5.2 5 6.5-2.6 1.3-4.3 3.6-5 6.5-.7-2.9-2.4-5.2-5-6.5 2.6-1.3 4.3-3.6 5-6.5z" /><path fill="#d97757" opacity=".55" d="M18.5 13c.35 1.45 1.2 2.6 2.5 3.25-1.3.65-2.15 1.8-2.5 3.25-.35-1.45-1.2-2.6-2.5-3.25 1.3-.65 2.15-1.8 2.5-3.25z" /></symbol>
        <symbol id="lg-deepseek" viewBox="0 0 24 24"><path fill="#4d6bfe" d="M3 15c2-1 3.5-3 4-6 .8 2.5 2.6 4.5 5 5.5-1 .8-2.4 1.3-4 1.3-1.9 0-3.6-.3-5-.8z" /><circle fill="#4d6bfe" cx="17.5" cy="6.5" r="2.4" /><path fill="#4d6bfe" opacity=".55" d="M13 18.5c2.5-.6 4.8-2 6.5-4.2.4 2.1.2 4.3-.5 6.2-1.8-1.2-3.9-1.9-6-2z" /></symbol>
        <symbol id="lg-pi" viewBox="0 0 24 24"><path fill="#bd93f9" d="M5 5.5h14v2.2h-2.1V19h-2.3V7.7h-3.4c-.3 4.2-1.6 8.2-3.9 11.3l-2-1.2c2.3-2.9 3.5-6.6 3.8-10.1H5z" /></symbol>
        <symbol id="lg-hermes" viewBox="0 0 24 24"><path fill="#ffb86c" d="M12 3l7 4v6c0 4-3 6.5-7 8-4-1.5-7-4-7-8V7z" /><path fill="#101118" d="M12 6.2l4.4 2.5v4.1c0 2.6-1.9 4.3-4.4 5.4-2.5-1.1-4.4-2.8-4.4-5.4V8.7z" opacity=".85" /><path fill="#ffb86c" d="M11 8h2v3h2.5l-4.5 6 .9-3.5H9.5z" /></symbol>
      </defs>
    </svg>
  );
}
